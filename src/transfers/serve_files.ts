import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import net from "node:net";
import { parseByteRange } from ".";
import { DEFAULT_USER_AGENT } from "../const";
import { errMsg } from "../shared";
import { socketCanEnd } from "../transport/socket_utils";
import type { ShareFile } from "../types";
import { sha1UrnFromUrn } from "../wire/content_urn";
import { hasToken } from "../wire/handshake";
import { parseHttpHeaders } from "../wire/http";
import { handleBrowseHostGet, isBrowseHostGetRequest } from "./browse";
import { openSharedFile } from "./file_access";
import type { TransferService } from "./service";
import type { ExistingGetRequest } from "./session_types";

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errMsg(error));
}

async function handleGetByFileIndex(
  transfers: TransferService,
  socket: net.Socket,
  head: string,
  first: string,
): Promise<boolean | undefined> {
  const match =
    /^(GET|HEAD)\s+\/get\/(\d+)\/(.+?)(?:\/)?\s+HTTP\/(\d+\.\d+)$/i.exec(
      first,
    );
  if (!match) return undefined;
  const fileIndex = Number(match[2]);
  const share = transfers.deps.shares.byIndex(fileIndex);
  if (!share) {
    socket.end("HTTP/1.0 404 Not Found\r\n\r\n");
    return false;
  }
  return await transfers.handleExistingGet(socket, head, share.abs, share);
}

async function handleUriResGet(
  transfers: TransferService,
  socket: net.Socket,
  head: string,
  first: string,
): Promise<boolean | undefined> {
  const match =
    /^(GET|HEAD)\s+\/uri-res\/N2R\?([^\s]+)\s+HTTP\/(\d+\.\d+)$/i.exec(
      first,
    );
  if (!match || !transfers.config().serveUriRes) return undefined;
  const rawUrn = decodeURIComponent(match[2]);
  const urn = (sha1UrnFromUrn(rawUrn) || rawUrn).toLowerCase();
  const share = transfers.deps.shares.byUrn(urn);
  if (!share) {
    socket.end("HTTP/1.0 404 Not Found\r\n\r\n");
    return false;
  }
  return await transfers.handleExistingGet(socket, head, share.abs, share);
}

/** Dispatch browse or file requests and report socket reuse. */
export async function handleIncomingGet(
  transfers: TransferService,
  socket: net.Socket,
  head: string,
  _body: Buffer = Buffer.alloc(0),
): Promise<boolean> {
  if (isBrowseHostGetRequest(head)) {
    return await handleBrowseHostGet(transfers, socket, head);
  }
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0];
  const byIndex = await handleGetByFileIndex(
    transfers,
    socket,
    head,
    first,
  );
  if (byIndex != null) return byIndex;
  const byUrn = await handleUriResGet(transfers, socket, head, first);
  if (byUrn != null) return byUrn;

  socket.end("HTTP/1.0 400 Bad Request\r\n\r\n");
  return false;
}

/** Read HTTP method, version, and connection preferences. */
export function parseExistingGetRequest(
  _transfers: TransferService,
  head: string,
): ExistingGetRequest {
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0];
  const method =
    /^(GET|HEAD)\s+/i.exec(first)?.[1]?.toUpperCase() || "GET";
  const httpVersion =
    /^([A-Z]+)\s+\S+\s+HTTP\/(\d+\.\d+)$/i.exec(first)?.[2] || "1.0";
  const headers = parseHttpHeaders(head);
  return {
    method,
    responseVersion: httpVersion === "1.1" ? "HTTP/1.1" : "HTTP/1.0",
    headers,
    keepAlive: !hasToken(headers["connection"], "close"),
  };
}

/** Send a 416 response and report socket reuse. */
export function writeInvalidRangeResponse(
  _transfers: TransferService,
  socket: net.Socket,
  request: ExistingGetRequest,
  size: number,
): boolean {
  socket.write(
    [
      `${request.responseVersion} 416 Range Not Satisfiable`,
      `Server: ${DEFAULT_USER_AGENT}`,
      "Content-Type: application/binary",
      "Content-Length: 0",
      `Content-Range: bytes */${size}`,
      `Connection: ${request.keepAlive ? "Keep-Alive" : "close"}`,
      "",
      "",
    ].join("\r\n"),
  );
  if (!request.keepAlive && socketCanEnd(socket)) socket.end();
  return request.keepAlive;
}

/** Calculate the byte length of an inclusive range. */
export function existingGetBodyLength(
  _transfers: TransferService,
  range: { start: number; end: number },
): number {
  return range.end >= range.start ? range.end - range.start + 1 : 0;
}

/** Build file response headers with range and URN metadata. */
export function buildExistingGetResponseHeaders(
  _transfers: TransferService,
  request: ExistingGetRequest,
  range: { start: number; end: number; partial: boolean },
  size: number,
  remaining: number,
  share?: ShareFile,
): string {
  return [
    range.partial
      ? `${request.responseVersion} 206 Partial Content`
      : `${request.responseVersion} 200 OK`,
    `Server: ${DEFAULT_USER_AGENT}`,
    "Content-Type: application/binary",
    `Content-Length: ${remaining}`,
    ...(range.partial
      ? [`Content-Range: bytes ${range.start}-${range.end}/${size}`]
      : []),
    ...(share?.sha1Urn
      ? [
          `X-Gnutella-Content-URN: ${share.sha1Urn}`,
          `X-Content-URN: ${share.sha1Urn}`,
        ]
      : []),
    `Connection: ${request.keepAlive ? "Keep-Alive" : "close"}`,
    "",
    "",
  ].join("\r\n");
}

/** End the socket unless the request allows reuse. */
export function finishExistingGetResponse(
  _transfers: TransferService,
  socket: net.Socket,
  keepAlive: boolean,
): boolean {
  if (!keepAlive && socketCanEnd(socket)) socket.end();
  return keepAlive;
}

/** Stream a file range to the requester. */
export async function streamExistingGetBody(
  _transfers: TransferService,
  socket: net.Socket,
  absPath: string,
  range: { start: number; end: number },
  keepAlive: boolean,
  file?: FileHandle,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const options = {
      start: range.start,
      end: range.end,
    };
    const rs = file
      ? file.createReadStream(options)
      : fs.createReadStream(absPath, options);
    let done = false;
    const cleanup = () => {
      rs.off("error", onError);
      rs.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onSocketError);
      rs.unpipe(socket);
      rs.destroy();
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      reject(toError(error));
    };
    const onError = (error: unknown) => fail(error);
    const onSocketError = (error: unknown) => fail(error);
    const onClose = () => finish();
    const onEnd = () => {
      if (!keepAlive && socketCanEnd(socket)) socket.end();
      finish();
    };
    rs.on("error", onError);
    rs.on("end", onEnd);
    socket.once("close", onClose);
    socket.once("error", onSocketError);
    rs.pipe(socket, { end: false });
  });
}

/** Serve a file or its headers with byte-range support. */
export async function handleExistingGet(
  transfers: TransferService,
  socket: net.Socket,
  head: string,
  absPath: string,
  share?: ShareFile,
): Promise<boolean> {
  const request = transfers.parseExistingGetRequest(head);
  const file = await openSharedFile(
    absPath,
    share ? transfers.config().downloadsDir : undefined,
  );
  try {
    const stat = await file.stat();
    const range = parseByteRange(request.headers["range"], stat.size);
    if (!range)
      return transfers.writeInvalidRangeResponse(
        socket,
        request,
        stat.size,
      );
    const remaining = transfers.existingGetBodyLength(range);
    socket.write(
      transfers.buildExistingGetResponseHeaders(
        request,
        range,
        stat.size,
        remaining,
        share,
      ),
    );
    if (request.method === "HEAD" || remaining === 0) {
      return transfers.finishExistingGetResponse(
        socket,
        request.keepAlive,
      );
    }
    await transfers.streamExistingGetBody(
      socket,
      absPath,
      range,
      request.keepAlive,
      file,
    );
    return request.keepAlive;
  } finally {
    await file.close();
  }
}
