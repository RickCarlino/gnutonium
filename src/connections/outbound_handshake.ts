import type net from "node:net";
import { errMsg, normalizeIpv4, normalizePeer, toBuffer } from "../shared";
import type { PeerCapabilities, PeerRole } from "../types";
import {
  boundedHeaderEnd,
  buildHandshakeBlock,
  describeHandshakeResponse,
  hasToken,
  mergeHeaders,
  parseHandshakeBlock,
} from "../wire/handshake";
import {
  blockedClientMessage,
  blockedClientSignature,
  maybeBlockClientHost,
} from "./client_blocking";
import type { PeerConnections } from "./connections";
import {
  emitHandshakeBlock,
  emitHandshakeDebug,
} from "./handshake_logging";
import { shouldUpgradeSocketToTls } from "./tls";

type OutboundHandshakeResult = {
  caps: PeerCapabilities;
  role: PeerRole;
  rest: Buffer;
  finalHeadersWithRemote: Record<string, string>;
};

/** Dial an endpoint and complete the 0.6 handshake. */
export async function connectPeer06(
  connections: PeerConnections,
  host: string,
  port: number,
  timeoutMs = connections.config().connectTimeoutMs,
): Promise<void> {
  const c = connections.config();
  const target = normalizePeer(host, port);
  if (connections.isBlockedHost(host))
    throw new Error(`peer ${target} is blocked`);
  emitHandshakeDebug(
    connections,
    "outbound",
    "dial-start",
    target,
    `timeoutMs=${timeoutMs}`,
  );
  await new Promise<void>((resolve, reject) => {
    const socket = connections.createConnection({ host, port });
    socket.setNoDelay(true);
    let decided = false;
    let buf = Buffer.alloc(0);

    const cleanup = () => {
      if (deadline) connections.deps.scheduler.clearTimeout(deadline);
      socket.setTimeout(0);
      socket.off("timeout", onTimeout);
      socket.off("error", fail);
      socket.off("close", onClose);
      socket.off("connect", onConnect);
      socket.off("data", onData);
    };

    const fail = (error: unknown) => {
      if (decided) return;
      decided = true;
      cleanup();
      emitHandshakeDebug(
        connections,
        "outbound",
        "failed",
        target,
        errMsg(error),
      );
      socket.destroy();
      reject(error instanceof Error ? error : new Error(errMsg(error)));
    };
    const onTimeout = () => fail(new Error("connect timeout"));

    const onConnect = () => {
      if (decided) return;
      try {
        if (connections.isBlockedHost(socket.remoteAddress)) {
          fail(
            new Error(`blocked IP ${normalizeIpv4(socket.remoteAddress)}`),
          );
          return;
        }
        const headers = connections.baseHandshakeHeaders(
          socket.remoteAddress,
        );
        if (
          connections.tlsEnabled() &&
          connections.canUpgradeSocketToTls(socket)
        )
          headers.upgrade = connections.tlsUpgradeToken();
        socket.write(buildHandshakeBlock("GNUTELLA CONNECT/0.6", headers));
        emitHandshakeBlock(
          connections,
          "outbound",
          "connect-sent",
          target,
          "GNUTELLA CONNECT/0.6",
          headers,
        );
      } catch (error) {
        fail(error);
      }
    };
    const onClose = () =>
      fail(new Error("socket closed during handshake"));
    const onData = (chunk: string | Buffer) => {
      if (decided) return;
      try {
        buf = Buffer.concat([buf, toBuffer(chunk)]);
        const result = parseOutboundHandshakeResult(
          connections,
          target,
          socket,
          buf,
          !!c.enableCompression,
        );
        if (!result) return;

        const { caps, role, rest, finalHeadersWithRemote } = result;
        const acceptance = connections.canAcceptPeerRole(role);
        if (!acceptance.ok) {
          socket.write(
            buildHandshakeBlock(
              `GNUTELLA/0.6 ${acceptance.code} ${acceptance.reason}`,
              {},
            ),
          );
          fail(
            new Error(
              `0.6 handshake rejected by ${target}: ${acceptance.reason}`,
            ),
          );
          return;
        }
        socket.write(
          buildHandshakeBlock(
            "GNUTELLA/0.6 200 OK",
            finalHeadersWithRemote,
          ),
        );
        emitHandshakeBlock(
          connections,
          "outbound",
          "final-sent",
          target,
          "GNUTELLA/0.6 200 OK",
          finalHeadersWithRemote,
        );
        cleanup();
        const upgradeToTls = shouldUpgradeSocketToTls(
          connections,
          socket,
          connections.peerAcceptedTlsUpgrade(caps.headers),
          true,
        );
        if (!upgradeToTls) {
          connections.attachPeer(
            socket,
            true,
            target,
            role,
            caps,
            rest,
            target,
          );
          decided = true;
          resolve();
          return;
        }
        emitHandshakeDebug(
          connections,
          "outbound",
          "tls-upgrade-start",
          target,
          "upgrading socket to TLS",
        );
        void connections
          .upgradeSocketToTls(socket, "client", rest)
          .then((tlsSocket) => {
            emitHandshakeDebug(
              connections,
              "outbound",
              "tls-upgrade-ok",
              target,
              "TLS active",
            );
            connections.attachPeer(
              tlsSocket,
              true,
              target,
              role,
              caps,
              Buffer.alloc(0),
              target,
            );
            resolve();
          })
          .catch((error) => {
            emitHandshakeDebug(
              connections,
              "outbound",
              "tls-upgrade-failed",
              target,
              errMsg(error),
            );
            socket.destroy();
            reject(
              error instanceof Error ? error : new Error(errMsg(error)),
            );
          });
        decided = true;
      } catch (error) {
        fail(error);
      }
    };
    socket.on("error", fail);
    socket.on("close", onClose);
    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.setTimeout(timeoutMs, onTimeout);
    const deadline = connections.deps.scheduler.setTimeout(
      onTimeout,
      timeoutMs,
    );
  });
}

function parseOutboundHandshakeResult(
  connections: PeerConnections,
  target: string,
  socket: net.Socket,
  buf: Buffer,
  compressionEnabled: boolean,
): OutboundHandshakeResult | undefined {
  const raw = buf.toString("latin1");
  const cut = boundedHeaderEnd(raw);
  if (cut === -1) return undefined;

  const { startLine, headers } = parseHandshakeBlock(raw.slice(0, cut));
  emitHandshakeBlock(
    connections,
    "outbound",
    "response-recv",
    target,
    startLine,
    headers,
  );
  const blockedSignature = blockedClientSignature(headers);
  if (blockedSignature) {
    const message = blockedClientMessage(
      blockedSignature,
      socket.remoteAddress,
    );
    maybeBlockClientHost(connections, socket.remoteAddress);
    emitHandshakeDebug(
      connections,
      "outbound",
      "blocked-client",
      target,
      message,
    );
    throw new Error(message);
  }
  connections.absorbHandshakeHeaders(headers, socket.remoteAddress);
  if (
    /^GNUTELLA OK/i.test(startLine) ||
    /^GNUTELLA\/0\.4 200/i.test(startLine)
  ) {
    throw new Error(
      `unsupported 0.4 handshake response from ${target}: ${describeHandshakeResponse(startLine, headers)}`,
    );
  }

  const match = /^GNUTELLA\/0\.([0-9]+)\s+(\d+)/i.exec(startLine);
  if (!match) {
    throw new Error(
      `unexpected handshake response from ${target}: ${describeHandshakeResponse(startLine, headers)}`,
    );
  }

  const code = Number(match[2]);
  if (code !== 200) {
    throw new Error(
      `0.6 handshake rejected by ${target}: ${describeHandshakeResponse(startLine, headers)}`,
    );
  }

  const finalHeadersWithRemote = connections.buildClientFinalHeaders(
    headers,
    socket.remoteAddress,
  );
  const compressIn =
    hasToken(headers["content-encoding"], "deflate") && compressionEnabled;
  const compressOut =
    hasToken(finalHeadersWithRemote["content-encoding"], "deflate") &&
    compressionEnabled;
  const caps = connections.buildCapabilities(
    `0.${match[1]}`,
    mergeHeaders(headers, finalHeadersWithRemote),
    compressIn,
    compressOut,
  );
  return {
    caps,
    role: connections.classifyPeerRole(caps),
    rest: buf.subarray(cut),
    finalHeadersWithRemote,
  };
}
