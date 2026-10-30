import net from "node:net";
import zlib from "node:zlib";
import type { PeerConnection as Peer } from "../connections/types";
import { DEFAULT_USER_AGENT, HEADER_LEN, TYPE } from "../const";
import { errMsg, parsePeer } from "../shared";
import { socketCanEnd } from "../transport/socket_utils";
import { buildHeader, encodeQueryHit, parseHeader } from "../wire/codec";
import { findHeaderEnd, hasToken } from "../wire/handshake";
import { parseHttpHeaders } from "../wire/http";
import type { TransferService } from "./service";
import type { ExistingGetRequest } from "./session_types";

const BROWSE_HOST_ACCEPT = "application/x-gnutella-packets";
const BROWSE_HOST_DESCRIPTOR_ID = Buffer.alloc(16, 0);
const BROWSE_HOST_BATCH_SIZE = 16;
// A browse response contains multiple packets, but must still have a finite budget.
const MAX_BROWSE_HOST_BODY_BYTES = 16 * 1024 * 1024;
const BROWSE_HOST_TIMEOUT_MESSAGE = "browse host timeout";

type BrowseTarget = {
  peer: Peer;
  host: string;
  port: number;
};

function acceptsBrowseHostQhits(request: ExistingGetRequest): boolean {
  const accept = request.headers["accept"];
  if (!accept) return false;
  return accept.split(",").some((part) => {
    const mediaType = part.split(";", 1)[0]?.trim().toLowerCase();
    return mediaType === BROWSE_HOST_ACCEPT;
  });
}

function buildBrowseHostResponse(
  statusLine: string,
  extraHeaders: string[] = [],
): string {
  return [
    statusLine,
    `Server: ${DEFAULT_USER_AGENT}`,
    ...extraHeaders,
    "X-Features: browse/1.0",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
}

function mediaTypeOf(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function parseContentLength(
  headers: Record<string, string>,
): number | undefined {
  const raw = headers["content-length"];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`invalid Content-Length ${JSON.stringify(raw)}`);
  return parsed;
}

function peerAddressMatches(
  peerSpec: string | undefined,
  host: string,
  port: number,
): boolean {
  const parsed = parsePeer(peerSpec || "");
  return !!parsed && parsed.host === host && parsed.port === port;
}

function peerMatchesBrowseAddress(
  peer: Peer,
  host: string,
  port: number,
): boolean {
  const fromListenIp = peer.capabilities.listenIp;
  if (
    fromListenIp &&
    fromListenIp.host === host &&
    fromListenIp.port === port
  ) {
    return true;
  }

  return (
    peerAddressMatches(peer.dialTarget, host, port) ||
    peerAddressMatches(peer.remoteLabel, host, port)
  );
}

function syntheticBrowsePeer(host: string, port: number): Peer {
  return {
    key: `${host}:${port}`,
    socket: new net.Socket(),
    buf: Buffer.alloc(0),
    outbound: true,
    remoteLabel: `${host}:${port}`,
    dialTarget: `${host}:${port}`,
    role: "leaf",
    capabilities: {
      version: "0.6",
      headers: {},
      supportsGgep: false,
      supportsPongCaching: false,
      supportsBye: false,
      supportsCompression: false,
      supportsTls: false,
      compressIn: false,
      compressOut: false,
      isUltrapeer: false,
      ultrapeerNeeded: false,
      isCrawler: false,
    },
    connectedAt: 0,
  };
}

function resolvePeerBrowseTarget(
  transfers: TransferService,
  peerKey: string,
): BrowseTarget | undefined {
  const peer = transfers.deps.connections.peers.get(peerKey);
  if (!peer) return undefined;
  const target = transfers.deps.connections.peerBrowseTarget(peer);
  const parsed = parsePeer(target || "");
  if (!parsed)
    throw new Error(`peer ${peerKey} has no browseable ip:port`);
  return { peer, host: parsed.host, port: parsed.port };
}

function resolveBrowseTarget(
  transfers: TransferService,
  target: string,
): BrowseTarget {
  const byPeer = resolvePeerBrowseTarget(transfers, target);
  if (byPeer) return byPeer;

  const parsed = parsePeer(target);
  if (!parsed) throw new Error(`no such peer ${target}`);
  if (transfers.deps.address.isSelfPeer(parsed.host, parsed.port)) {
    throw new Error("cannot browse self");
  }

  const existingPeer = [...transfers.deps.connections.peers.values()].find(
    (peer) => peerMatchesBrowseAddress(peer, parsed.host, parsed.port),
  );
  return {
    peer: existingPeer || syntheticBrowsePeer(parsed.host, parsed.port),
    host: parsed.host,
    port: parsed.port,
  };
}

function buildBrowseHostRequest(
  transfers: TransferService,
  host: string,
  port: number,
): string {
  return [
    "GET / HTTP/1.1",
    `Host: ${host}:${port}`,
    `User-Agent: ${transfers.config().userAgent}`,
    `Accept: ${BROWSE_HOST_ACCEPT}`,
    "Accept-Encoding: deflate",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
}

function parseChunkSizeLine(
  body: Buffer,
  offset: number,
): {
  size: number;
  nextOffset: number;
} {
  const lineEnd = body.indexOf(Buffer.from("\r\n"), offset);
  if (lineEnd === -1) throw new Error("invalid chunked browse-host body");
  const rawSize = body
    .subarray(offset, lineEnd)
    .toString("latin1")
    .split(";", 1)[0]
    ?.trim();
  const size = Number.parseInt(rawSize || "", 16);
  if (!Number.isFinite(size) || size < 0)
    throw new Error(
      `invalid browse-host chunk size ${JSON.stringify(rawSize)}`,
    );
  return { size, nextOffset: lineEnd + 2 };
}

function assertChunkTerminator(body: Buffer, offset: number): void {
  if (body.toString("latin1", offset, offset + 2) !== "\r\n") {
    throw new Error("invalid browse-host chunk terminator");
  }
}

function decodeChunkedBody(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;

  while (offset < body.length) {
    const parsed = parseChunkSizeLine(body, offset);
    const size = parsed.size;
    offset = parsed.nextOffset;
    if (size === 0) return Buffer.concat(parts);
    if (offset + size + 2 > body.length)
      throw new Error("truncated browse-host chunk");
    parts.push(body.subarray(offset, offset + size));
    offset += size;
    assertChunkTerminator(body, offset);
    offset += 2;
  }

  throw new Error("truncated browse-host chunked stream");
}

function decodeBrowseHostBody(
  headers: Record<string, string>,
  body: Buffer,
): Buffer {
  const transferEncoding = headers["transfer-encoding"];
  let decoded = body;
  if (transferEncoding && !hasToken(transferEncoding, "chunked")) {
    throw new Error(
      `unsupported Transfer-Encoding ${JSON.stringify(transferEncoding)}`,
    );
  }
  if (hasToken(transferEncoding, "chunked")) {
    decoded = decodeChunkedBody(decoded);
  }

  const contentEncoding = headers["content-encoding"];
  if (!contentEncoding) return decoded;
  if (!hasToken(contentEncoding, "deflate")) {
    throw new Error(
      `unsupported Content-Encoding ${JSON.stringify(contentEncoding)}`,
    );
  }
  return zlib.inflateSync(decoded, {
    maxOutputLength: MAX_BROWSE_HOST_BODY_BYTES,
  });
}

async function readBrowseHostHttpResponse(
  socket: net.Socket,
): Promise<{ head: string; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    let done = false;
    let buf = Buffer.alloc(0);
    let headerEnd = -1;
    let expectedBodyBytes: number | undefined;

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(errMsg(error)));
    };

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      if (headerEnd === -1) {
        reject(new Error("missing browse-host HTTP response headers"));
        return;
      }
      const head = buf.subarray(0, headerEnd).toString("latin1");
      const body = buf.subarray(headerEnd);
      if (expectedBodyBytes != null && body.length < expectedBodyBytes) {
        reject(new Error("incomplete browse-host HTTP response body"));
        return;
      }
      resolve({
        head,
        body:
          expectedBodyBytes == null
            ? body
            : body.subarray(0, expectedBodyBytes),
      });
    };

    const maybeParseHeaders = () => {
      if (headerEnd !== -1) return;
      const cut = findHeaderEnd(buf.toString("latin1"));
      if (cut === -1) return;
      headerEnd = cut;
      expectedBodyBytes = parseContentLength(
        parseHttpHeaders(buf.subarray(0, cut).toString("latin1")),
      );
    };

    const onData = (chunk: string | Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      maybeParseHeaders();
      if (
        headerEnd !== -1 &&
        expectedBodyBytes != null &&
        buf.length - headerEnd >= expectedBodyBytes
      ) {
        finish();
      }
    };

    const onEnd = () => finish();
    const onClose = () => {
      if (done) return;
      if (
        headerEnd !== -1 &&
        (expectedBodyBytes == null ||
          buf.length - headerEnd >= expectedBodyBytes)
      ) {
        finish();
        return;
      }
      fail(
        new Error(
          "browse-host connection closed before response completed",
        ),
      );
    };
    const onError = (error: unknown) => fail(error);

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

function validateBrowseHostResponse(head: string): Record<string, string> {
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0] || "";
  const status = Number(/^HTTP\/\d+\.\d+\s+(\d+)/i.exec(first)?.[1]);
  if (!Number.isFinite(status))
    throw new Error("invalid browse-host HTTP response");
  if (status === 406) {
    throw new Error("browse host rejected application/x-gnutella-packets");
  }
  if (status !== 200) {
    throw new Error(`browse host failed with ${first}`);
  }

  const headers = parseHttpHeaders(head);
  if (mediaTypeOf(headers["content-type"]) !== BROWSE_HOST_ACCEPT) {
    throw new Error(
      `unexpected browse-host content type ${JSON.stringify(headers["content-type"] || "")}`,
    );
  }
  return headers;
}

async function connectBrowseHostSocket(
  transfers: TransferService,
  socket: net.Socket,
  host: string,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      socket.removeListener("connect", onConnect);
      reject(error instanceof Error ? error : new Error(errMsg(error)));
    };
    const onConnect = () => {
      socket.removeListener("error", onError);
      socket.write(buildBrowseHostRequest(transfers, host, port));
      resolve();
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function ingestBrowseHostBody(
  transfers: TransferService,
  peer: Peer,
  body: Buffer,
  browseDescriptorId: Buffer,
): number {
  const descriptorIdHex = browseDescriptorId.toString("hex");
  let added = 0;
  for (let offset = 0; offset < body.length;) {
    if (offset + HEADER_LEN > body.length) {
      throw new Error("truncated browse-host packet header");
    }
    const packetHeader = parseHeader(
      body.subarray(offset, offset + HEADER_LEN),
    );
    offset += HEADER_LEN;
    if (offset + packetHeader.payloadLength > body.length) {
      throw new Error("truncated browse-host packet payload");
    }
    if (packetHeader.payloadType !== TYPE.QUERY_HIT) {
      throw new Error(
        `unexpected browse-host packet type 0x${packetHeader.payloadType.toString(16)}`,
      );
    }
    const payload = body.subarray(
      offset,
      offset + packetHeader.payloadLength,
    );
    offset += packetHeader.payloadLength;
    added += transfers.deps.router.ingestBrowse(
      peer,
      {
        descriptorId: browseDescriptorId,
        descriptorIdHex,
        payloadType: packetHeader.payloadType,
        ttl: packetHeader.ttl,
        hops: packetHeader.hops,
      },
      payload,
    );
  }

  return added;
}

/** Fetch a peer's shared-file listing and count ingested hits. */
export async function browsePeer(
  transfers: TransferService,
  targetSpec: string,
  descriptorId: Buffer,
): Promise<number> {
  const target = resolveBrowseTarget(transfers, targetSpec);
  const socket = transfers.createConnection({
    host: target.host,
    port: target.port,
  });
  socket.setNoDelay(true);
  socket.setTimeout(transfers.config().downloadTimeoutMs, () =>
    socket.destroy(new Error(BROWSE_HOST_TIMEOUT_MESSAGE)),
  );
  const responsePromise = readBrowseHostHttpResponse(socket);

  try {
    await connectBrowseHostSocket(
      transfers,
      socket,
      target.host,
      target.port,
    );
    const { head, body } = await responsePromise;
    const headers = validateBrowseHostResponse(head);

    return ingestBrowseHostBody(
      transfers,
      target.peer,
      decodeBrowseHostBody(headers, body),
      descriptorId,
    );
  } catch (error) {
    await responsePromise.catch(() => undefined);
    throw error;
  } finally {
    if (socketCanEnd(socket)) socket.end();
  }
}

function buildBrowseHostBody(transfers: TransferService): Buffer {
  const packets: Buffer[] = [];
  for (
    let offset = 0;
    offset < transfers.deps.shares.list().length;
    offset += BROWSE_HOST_BATCH_SIZE
  ) {
    const batch = transfers.deps.shares
      .list()
      .slice(offset, offset + BROWSE_HOST_BATCH_SIZE);
    const payload = encodeQueryHit(
      transfers.deps.address.currentAdvertisedPort(),
      transfers.deps.address.currentAdvertisedHost(),
      transfers.config().advertisedSpeedKBps,
      batch,
      transfers.deps.serventId,
      {
        vendorCode: transfers.config().vendorCode,
        busy: false,
        haveUploaded: false,
        measuredSpeed: true,
        push: false,
        ggepHashes: !!transfers.config().enableGgep,
        browseHost: !!transfers.config().enableGgep,
      },
    );
    packets.push(
      buildHeader(
        BROWSE_HOST_DESCRIPTOR_ID,
        TYPE.QUERY_HIT,
        0,
        0,
        payload,
      ),
    );
  }
  return Buffer.concat(packets);
}

/** Recognize GET or HEAD requests for the browse endpoint. */
export function isBrowseHostGetRequest(head: string): boolean {
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0] || "";
  return /^(GET|HEAD)\s+\/\s+HTTP\/(\d+\.\d+)$/i.test(first);
}

/** Serve local shares as a browse-host query-hit stream. */
export async function handleBrowseHostGet(
  transfers: TransferService,
  socket: net.Socket,
  head: string,
): Promise<boolean> {
  const request = transfers.parseExistingGetRequest(head);
  if (!acceptsBrowseHostQhits(request)) {
    socket.write(
      buildBrowseHostResponse("HTTP/1.1 406 Not Acceptable", [
        "Content-Length: 0",
      ]),
    );
    if (socketCanEnd(socket)) socket.end();
    return false;
  }

  socket.write(
    buildBrowseHostResponse(`${request.responseVersion} 200 OK`, [
      `Content-Type: ${BROWSE_HOST_ACCEPT}`,
    ]),
  );
  if (request.method !== "HEAD") {
    socket.write(buildBrowseHostBody(transfers));
  }
  if (socketCanEnd(socket)) socket.end();
  return false;
}
