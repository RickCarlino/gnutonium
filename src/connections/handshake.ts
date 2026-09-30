import net from "node:net";
import { MAX_XTRY } from "../const";
import { isAllowedPeerReferral } from "../discovery/addresses";
import {
  errMsg,
  normalizeIpv4,
  normalizePeer,
  parsePeer,
  toBuffer,
  ts,
} from "../shared";
import type { PeerCapabilities, PeerRole } from "../types";
import {
  buildHandshakeBlock,
  describeHandshakeResponse,
  findHeaderEnd,
  hasToken,
  mergeHeaders,
  parseHandshakeBlock,
  parsePeerHeaderList,
} from "../wire/handshake";
import {
  blockedClientMessage,
  blockedClientSignature,
} from "./client_blocking";
import type { PeerConnections } from "./connections";
import {
  buildBaseHandshakeHeaders,
  buildPeerCapabilities,
  buildClientFinalHeaders as buildPolicyClientFinalHeaders,
  buildServerHandshakeHeaders as buildPolicyServerHandshakeHeaders,
  buildRejectHeaders,
  type LocalHandshakePolicy,
} from "./policy";
import type { ProbeCtx } from "./types";

type OutboundHandshakeResult = {
  caps: PeerCapabilities;
  role: PeerRole;
  rest: Buffer;
  finalHeadersWithRemote: Record<string, string>;
};

/** Classify and negotiate an incoming socket. */
export function handleProbe(
  connections: PeerConnections,
  socket: net.Socket,
): void {
  const blockedIp = normalizeIpv4(socket.remoteAddress);
  if (blockedIp && connections.isBlockedHost(blockedIp)) {
    const message = blockedProbeMessage(blockedIp);
    emitHandshakeDebug(
      connections,
      "inbound",
      "blocked",
      handshakePeerLabel(socket),
      message,
    );
    connections.deps.emit({
      type: "PROBE_REJECTED",
      at: ts(),
      message,
    });
    socket.destroy();
    return;
  }
  const ctx: ProbeCtx = {
    socket,
    buf: Buffer.alloc(0),
    receivedBytes: 0,
    startedAtMs: connections.now(),
    mode: "undecided",
  };
  emitHandshakeDebug(
    connections,
    "inbound",
    "probe-open",
    handshakePeerLabel(socket),
    "awaiting inbound protocol bytes",
  );
  socket.setNoDelay(true);
  ctx.onData = (chunk) => {
    if (ctx.mode === "done") return;
    const data = toBuffer(chunk);
    ctx.receivedBytes += data.length;
    ctx.buf = Buffer.concat([ctx.buf, data]);
    try {
      connections.tryDecideProbe(ctx);
    } catch (error) {
      const message = errMsg(error);
      emitHandshakeDebug(
        connections,
        "inbound",
        "failed",
        handshakePeerLabel(socket),
        message,
      );
      connections.deps.emit({
        type: "PROBE_REJECTED",
        at: ts(),
        message,
      });
      finishProbe(ctx);
      socket.destroy();
    }
  };
  ctx.onEnd = () => terminateProbeEarly(connections, ctx, "end");
  ctx.onClose = (hadError) =>
    terminateProbeEarly(
      connections,
      ctx,
      "close",
      hadError ? "hadError=true" : undefined,
    );
  ctx.onError = (error) => {
    terminateProbeEarly(connections, ctx, "error", errMsg(error));
    socket.destroy();
  };
  socket.on("data", ctx.onData);
  socket.on("end", ctx.onEnd);
  socket.on("close", ctx.onClose);
  socket.on("error", ctx.onError);
}

/** Advance an inbound probe using buffered bytes. */
export function tryDecideProbe(
  connections: PeerConnections,
  ctx: ProbeCtx,
): void {
  if (ctx.mode === "undecided") {
    connections.handleUndecidedProbe(ctx);
    return;
  }
  if (ctx.mode === "await-final-0.6")
    connections.finishInbound06Probe(ctx);
}

/** Distinguish TLS, Gnutella, HTTP, and GIV traffic. */
export function handleUndecidedProbe(
  connections: PeerConnections,
  ctx: ProbeCtx,
): void {
  if (ctx.buf.length >= 2 && ctx.buf[0] === 22 && ctx.buf[1] === 3) {
    acceptEncryptedProbe(connections, ctx);
    return;
  }
  const raw = ctx.buf.toString("latin1");
  if (raw.startsWith("GNUTELLA CONNECT/0.6")) {
    connections.handleInbound06Probe(ctx, raw);
    return;
  }
  if (/^GNUTELLA CONNECT\/0\./i.test(raw)) {
    connections.rejectLegacyInboundProbe(raw);
    return;
  }
  if (/^(GET|HEAD|POST)\s+/i.test(raw)) {
    connections.startHttpProbeSession(ctx, raw);
    return;
  }
  if (raw.startsWith("GIV ")) {
    connections.startGivProbeSession(ctx, raw);
    return;
  }
  if (ctx.buf.length > 8192) throw new Error("unknown inbound protocol");
}

/** Validate an inbound 0.6 request and send a response. */
export function handleInbound06Probe(
  connections: PeerConnections,
  ctx: ProbeCtx,
  raw: string,
): void {
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  const { startLine, headers } = parseHandshakeBlock(raw.slice(0, cut));
  emitHandshakeBlock(
    connections,
    "inbound",
    "connect-recv",
    handshakePeerLabel(ctx.socket),
    startLine,
    headers,
  );
  if (!/^GNUTELLA CONNECT\/0\.[0-9]+/i.test(startLine)) {
    throw new Error(`unexpected 0.6 start line: ${startLine}`);
  }
  const blockedSignature = blockedClientSignature(headers);
  if (blockedSignature) {
    const message = blockedClientMessage(
      blockedSignature,
      ctx.socket.remoteAddress,
    );
    maybeBlockClientHost(connections, ctx.socket.remoteAddress);
    emitHandshakeDebug(
      connections,
      "inbound",
      "blocked-client",
      handshakePeerLabel(ctx.socket),
      message,
    );
    connections.deps.emit({
      type: "PROBE_REJECTED",
      at: ts(),
      message,
    });
    connections.reject06(ctx.socket, 503, "Blocked client");
    finishProbe(ctx);
    return;
  }
  connections.absorbHandshakeHeaders(headers, ctx.socket.remoteAddress);
  const requestedCaps = connections.buildCapabilities(
    "0.6",
    headers,
    false,
    false,
  );
  const requestedRole = connections.classifyPeerRole(requestedCaps);
  const acceptance = connections.canAcceptPeerRole(requestedRole);
  if (!acceptance.ok) {
    connections.reject06(ctx.socket, acceptance.code, acceptance.reason);
    ctx.mode = "done";
    clearProbeListeners(ctx);
    return;
  }
  ctx.requestHeaders = headers;
  ctx.serverHeaders = connections.buildServerHandshakeHeaders(
    headers,
    ctx.socket.remoteAddress,
  );
  ctx.socket.write(
    buildHandshakeBlock("GNUTELLA/0.6 200 OK", ctx.serverHeaders),
  );
  emitHandshakeBlock(
    connections,
    "inbound",
    "response-sent",
    handshakePeerLabel(ctx.socket),
    "GNUTELLA/0.6 200 OK",
    ctx.serverHeaders,
  );
  ctx.buf = ctx.buf.subarray(cut);
  ctx.mode = "await-final-0.6";
  connections.tryDecideProbe(ctx);
}

/** Complete inbound negotiation and attach the peer. */
export function finishInbound06Probe(
  connections: PeerConnections,
  ctx: ProbeCtx,
): void {
  const raw = ctx.buf.toString("latin1");
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  const { startLine, headers } = parseHandshakeBlock(raw.slice(0, cut));
  connections.absorbHandshakeHeaders(headers, ctx.socket.remoteAddress);
  emitHandshakeBlock(
    connections,
    "inbound",
    "final-recv",
    handshakePeerLabel(ctx.socket),
    startLine,
    headers,
  );
  if (finalHandshakeCode(startLine) !== 200) {
    throw new Error(`client rejected connection: ${startLine}`);
  }

  const requestHeaders = ctx.requestHeaders || {};
  const serverHeaders = ctx.serverHeaders || {};
  const compressionEnabled = !!connections.config().enableCompression;
  const compressIn = compressionAccepted(compressionEnabled, headers);
  const compressOut = compressionAccepted(
    compressionEnabled,
    serverHeaders,
  );
  const caps = connections.buildCapabilities(
    "0.6",
    mergeHeaders(requestHeaders, headers),
    compressIn,
    compressOut,
  );
  const role = connections.classifyPeerRole(caps);
  const rest = ctx.buf.subarray(cut);
  ctx.mode = "done";
  clearProbeListeners(ctx);
  const remoteLabel = handshakePeerLabel(ctx.socket);
  attachInbound06Peer(
    connections,
    ctx.socket,
    remoteLabel,
    role,
    caps,
    rest,
    serverHeaders,
    headers,
  );
}

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
    socket.setTimeout(timeoutMs, () => fail(new Error("connect timeout")));

    const onConnect = () => {
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
    };
    const onClose = () =>
      fail(new Error("socket closed during handshake"));
    const onData = (chunk: string | Buffer) => {
      if (decided) return;
      buf = Buffer.concat([buf, toBuffer(chunk)]);
      let result: OutboundHandshakeResult | undefined;
      try {
        result = parseOutboundHandshakeResult(
          connections,
          target,
          socket,
          buf,
          !!c.enableCompression,
        );
      } catch (error) {
        fail(error);
        return;
      }
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
        buildHandshakeBlock("GNUTELLA/0.6 200 OK", finalHeadersWithRemote),
      );
      emitHandshakeBlock(
        connections,
        "outbound",
        "final-sent",
        target,
        "GNUTELLA/0.6 200 OK",
        finalHeadersWithRemote,
      );
      decided = true;
      socket.setTimeout(0);
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
    };
    socket.on("error", fail);
    socket.on("close", onClose);
    socket.on("connect", onConnect);
    socket.on("data", onData);
  });
}

function clearProbeListeners(ctx: ProbeCtx): void {
  if (ctx.onData) ctx.socket.off("data", ctx.onData);
  if (ctx.onEnd) ctx.socket.off("end", ctx.onEnd);
  if (ctx.onClose) ctx.socket.off("close", ctx.onClose);
  if (ctx.onError) ctx.socket.off("error", ctx.onError);
}

function blockedProbeMessage(ip: string): string {
  return `blocked IP ${ip}`;
}

function maybeBlockClientHost(
  connections: PeerConnections,
  remoteHost: string | undefined,
): string | undefined {
  const ip = normalizeIpv4(remoteHost);
  if (!ip) return undefined;
  connections.blockIp(ip);
  return ip;
}

function probePreview(buf: Buffer): string | undefined {
  const preview = buf
    .toString("latin1")
    .replace(/\r\n/g, "\\r\\n")
    .replace(/\n/g, "\\n")
    .trim();
  if (!preview) return undefined;
  return preview.length > 96 ? `${preview.slice(0, 96)}...` : preview;
}

function describeProbeState(
  ctx: ProbeCtx,
  reason: string,
  ageMs: number,
  detail?: string,
): string {
  const parts = [
    `reason=${reason}`,
    `mode=${ctx.mode}`,
    `bytes=${ctx.receivedBytes}`,
    `ageMs=${ageMs}`,
  ];
  if (detail) parts.push(detail);
  const preview = probePreview(ctx.buf);
  if (preview) parts.push(`preview=${JSON.stringify(preview)}`);
  return parts.join(" ");
}

function finishProbe(ctx: ProbeCtx): void {
  ctx.mode = "done";
  clearProbeListeners(ctx);
}

function terminateProbeEarly(
  connections: PeerConnections,
  ctx: ProbeCtx,
  reason: string,
  detail?: string,
): void {
  if (ctx.mode === "done") return;
  const ageMs = Math.max(0, connections.now() - ctx.startedAtMs);
  emitHandshakeDebug(
    connections,
    "inbound",
    "terminated-early",
    handshakePeerLabel(ctx.socket),
    describeProbeState(ctx, reason, ageMs, detail),
  );
  finishProbe(ctx);
}

function handshakePeerLabel(socket: net.Socket): string {
  return `${socket.remoteAddress || "?"}:${socket.remotePort || "?"}`;
}

function emitHandshakeDebug(
  connections: PeerConnections,
  direction: "inbound" | "outbound",
  phase: string,
  peer: string,
  message: string,
): void {
  connections.deps.emit({
    type: "HANDSHAKE_DEBUG",
    at: ts(),
    direction,
    phase,
    peer,
    message,
  });
}

function emitHandshakeBlock(
  connections: PeerConnections,
  direction: "inbound" | "outbound",
  phase: string,
  peer: string,
  startLine: string,
  headers: Record<string, string>,
): void {
  emitHandshakeDebug(
    connections,
    direction,
    phase,
    peer,
    describeHandshakeResponse(startLine, headers),
  );
}

function localHandshakePolicy(
  connections: PeerConnections,
  tlsEnabled = connections.tlsEnabled(),
): LocalHandshakePolicy {
  const c = connections.config();
  return {
    userAgent: c.userAgent,
    advertisedHost: connections.deps.address.currentAdvertisedHost(),
    advertisedPort: connections.deps.address.currentAdvertisedPort(),
    maxTtl: c.maxTtl,
    nodeMode: connections.nodeMode(),
    maxUltrapeerConnections: c.maxUltrapeerConnections,
    maxLeafConnections: c.maxLeafConnections,
    connectedMeshPeerCount: connections.connectedMeshPeerCount(),
    connectedLeafCount: connections.connectedLeafCount(),
    enableQrp: c.enableQrp,
    queryRoutingVersion: c.queryRoutingVersion,
    enableCompression: c.enableCompression,
    enablePongCaching: c.enablePongCaching,
    enableGgep: c.enableGgep,
    enableBye: c.enableBye,
    tlsEnabled,
    tlsUpgradeToken: connections.tlsUpgradeToken(),
  };
}

/** Build local identity and feature headers. */
export function baseHandshakeHeaders(
  connections: PeerConnections,
  remoteIp?: string,
): Record<string, string> {
  return buildBaseHandshakeHeaders(
    localHandshakePolicy(connections, false),
    remoteIp,
  );
}

/** Negotiate server compression and TLS response headers. */
export function buildServerHandshakeHeaders(
  connections: PeerConnections,
  requestHeaders: Record<string, string>,
  remoteIp?: string,
): Record<string, string> {
  return buildPolicyServerHandshakeHeaders(
    localHandshakePolicy(connections),
    requestHeaders,
    remoteIp,
  );
}

/** Confirm negotiated compression and TLS headers. */
export function buildClientFinalHeaders(
  connections: PeerConnections,
  serverHeaders: Record<string, string>,
  remoteIp?: string,
): Record<string, string> {
  return buildPolicyClientFinalHeaders(
    localHandshakePolicy(connections),
    serverHeaders,
    remoteIp,
  );
}

/** Interpret negotiated remote features and compression. */
export function buildCapabilities(
  connections: PeerConnections,
  version: string,
  headers: Record<string, string>,
  compressIn: boolean,
  compressOut: boolean,
): PeerCapabilities {
  return buildPeerCapabilities({
    version,
    headers,
    compressIn,
    compressOut,
    tlsEnabled: connections.tlsEnabled(),
    tlsUpgradeToken: connections.tlsUpgradeToken(),
  });
}

/** Select alternate endpoints to advertise in handshakes. */
export function selectTryPeers(
  connections: PeerConnections,
  limit = MAX_XTRY,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (peerSpec?: string) => {
    if (!peerSpec) return;
    const addr = parsePeer(peerSpec);
    if (!addr) return;
    const peer = normalizePeer(addr.host, addr.port);
    if (connections.isBlockedHost(addr.host)) return;
    if (
      connections.deps.address.isSelfPeer(addr.host, addr.port) ||
      seen.has(peer)
    )
      return;
    seen.add(peer);
    out.push(peer);
  };

  for (const peer of connections.peers.values()) {
    if (peer.capabilities.listenIp) {
      push(
        normalizePeer(
          peer.capabilities.listenIp.host,
          peer.capabilities.listenIp.port,
        ),
      );
    } else if (peer.dialTarget) {
      push(peer.dialTarget);
    } else {
      push(peer.remoteLabel);
    }
    if (out.length >= limit) return out;
  }

  for (const peerSpec of connections.deps.discovery.getKnownPeers()) {
    push(peerSpec);
    if (out.length >= limit) break;
  }
  return out;
}

/** Remember alternate peers advertised in headers. */
export function maybeAbsorbTryHeaders(
  connections: PeerConnections,
  headers: Record<string, string>,
  reporterHost?: string,
): void {
  for (const addr of [
    ...parsePeerHeaderList(headers["x-try"]),
    ...parsePeerHeaderList(headers["x-try-ultrapeers"]),
  ]) {
    if (!isAllowedPeerReferral(addr.host, reporterHost)) continue;
    connections.deps.discovery.addKnownPeer(addr.host, addr.port);
  }
}

/** Send a 0.6 rejection and close the socket. */
export function reject06(
  connections: PeerConnections,
  socket: net.Socket,
  code: number,
  reason: string,
  extraHeaders: Record<string, string> = {},
): void {
  const tryPeers = connections.selectTryPeers();
  const headers = buildRejectHeaders({
    extraHeaders,
    remoteIp: socket.remoteAddress,
    tryPeers,
  });
  emitHandshakeBlock(
    connections,
    "inbound",
    "reject-sent",
    handshakePeerLabel(socket),
    `GNUTELLA/0.6 ${code} ${reason}`,
    headers,
  );
  socket.end(
    buildHandshakeBlock(`GNUTELLA/0.6 ${code} ${reason}`, headers),
  );
}

function acceptEncryptedProbe(
  connections: PeerConnections,
  ctx: ProbeCtx,
): void {
  if (!connections.tlsEnabled() || connections.socketUsesTls(ctx.socket))
    throw new Error("unexpected TLS handshake");
  finishProbe(ctx);
  void connections.upgradeSocketToTls(ctx.socket, "server", ctx.buf).then(
    (socket) => connections.handleProbe(socket),
    (error: unknown) => {
      ctx.socket.destroy();
      connections.deps.emit({
        type: "PROBE_REJECTED",
        at: ts(),
        message: errMsg(error),
      });
    },
  );
}

/** Reject a complete unsupported Gnutella handshake. */
export function rejectLegacyInboundProbe(
  _connections: PeerConnections,
  raw: string,
): void {
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  const { startLine } = parseHandshakeBlock(raw.slice(0, cut));
  throw new Error(`unsupported inbound handshake: ${startLine}`);
}

/** Hand a complete HTTP request to the transfer service. */
export function startHttpProbeSession(
  connections: PeerConnections,
  ctx: ProbeCtx,
  raw: string,
): void {
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  ctx.mode = "done";
  clearProbeListeners(ctx);
  connections.deps.ingress.http(
    ctx.socket,
    raw.slice(0, cut),
    ctx.buf.subarray(cut),
  );
}

/** Hand a complete push callback to the transfer service. */
export function startGivProbeSession(
  connections: PeerConnections,
  ctx: ProbeCtx,
  raw: string,
): void {
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  ctx.mode = "done";
  clearProbeListeners(ctx);
  void connections.deps.ingress
    .giv(ctx.socket, raw.slice(0, cut))
    .catch(() => ctx.socket.destroy());
}

function finalHandshakeCode(startLine: string): number {
  const match = /^GNUTELLA\/0\.[0-9]+\s+(\d+)/i.exec(startLine);
  if (!match) throw new Error(`unexpected final 0.6 line: ${startLine}`);
  return Number(match[1]);
}

function compressionAccepted(
  enabled: boolean,
  headers: Record<string, string>,
): boolean {
  return enabled && hasToken(headers["content-encoding"], "deflate");
}

function shouldUpgradeSocketToTls(
  connections: PeerConnections,
  socket: net.Socket,
  acceptedByServer: boolean,
  acceptedByClient: boolean,
): boolean {
  return (
    connections.tlsEnabled() &&
    connections.canUpgradeSocketToTls(socket) &&
    acceptedByServer &&
    acceptedByClient
  );
}

function attachInbound06Peer(
  connections: PeerConnections,
  socket: net.Socket,
  remoteLabel: string,
  role: PeerRole,
  caps: PeerCapabilities,
  rest: Buffer,
  serverHeaders: Record<string, string>,
  clientHeaders: Record<string, string>,
): void {
  const upgradeToTls = shouldUpgradeSocketToTls(
    connections,
    socket,
    connections.peerAcceptedTlsUpgrade(serverHeaders),
    connections.clientAcceptedTlsUpgrade(clientHeaders),
  );
  if (!upgradeToTls) {
    connections.attachPeer(socket, false, remoteLabel, role, caps, rest);
    return;
  }
  emitHandshakeDebug(
    connections,
    "inbound",
    "tls-upgrade-start",
    remoteLabel,
    "upgrading socket to TLS",
  );
  void connections
    .upgradeSocketToTls(socket, "server", rest)
    .then((tlsSocket) => {
      emitHandshakeDebug(
        connections,
        "inbound",
        "tls-upgrade-ok",
        remoteLabel,
        "TLS active",
      );
      connections.attachPeer(tlsSocket, false, remoteLabel, role, caps);
    })
    .catch((error) => {
      emitHandshakeDebug(
        connections,
        "inbound",
        "tls-upgrade-failed",
        remoteLabel,
        errMsg(error),
      );
      connections.deps.emit({
        type: "PROBE_REJECTED",
        at: ts(),
        message: `TLS upgrade failed: ${errMsg(error)}`,
      });
      socket.destroy();
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
  const cut = findHeaderEnd(raw);
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
