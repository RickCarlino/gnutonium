import {
  errMsg,
  normalizeIpv4,
  normalizePeer,
  parsePeer,
  unique,
} from "../shared";
import type {
  BlockIpResult,
  ConnectPeerResult,
  PeerInfo,
  UnblockIpResult,
} from "../types";
import type { PeerConnections } from "./connections";
import type { PeerConnection as Peer } from "./types";

/** Build a public summary of a connected peer. */
export function peerInfo(
  connections: PeerConnections,
  peer: Peer,
): PeerInfo {
  const info: PeerInfo = {
    key: peer.key,
    remoteLabel: peer.remoteLabel,
    browseTarget: peerBrowseTarget(connections, peer),
    role: peer.role,
    outbound: peer.outbound,
    dialTarget: peer.dialTarget,
    compression:
      !!peer.capabilities.compressIn || !!peer.capabilities.compressOut,
    tls: connections.socketUsesTls(peer.socket),
  };
  if (peer.capabilities.userAgent)
    info.userAgent = peer.capabilities.userAgent;
  return info;
}

/** Choose a usable browsing endpoint for a peer. */
export function peerBrowseTarget(
  connections: PeerConnections,
  peer: Peer,
): string | undefined {
  const fromListenIp = peer.capabilities.listenIp;
  if (
    fromListenIp &&
    !connections.deps.address.isSelfPeer(
      fromListenIp.host,
      fromListenIp.port,
    )
  ) {
    return `${fromListenIp.host}:${fromListenIp.port}`;
  }

  const candidates = [
    peer.dialTarget,
    peer.outbound ? peer.remoteLabel : undefined,
    peer.remoteLabel,
  ];
  for (const candidate of candidates) {
    const parsed = parsePeer(candidate || "");
    if (
      !parsed ||
      connections.deps.address.isSelfPeer(parsed.host, parsed.port)
    )
      continue;
    return `${parsed.host}:${parsed.port}`;
  }

  return undefined;
}

/** Count currently connected peers. */
export function peerCount(connections: PeerConnections): number {
  return connections.peers.size;
}

/** Return the configured blocked IPv4 addresses. */
export function getBlockedIps(connections: PeerConnections): string[] {
  return [...connections.config().blockedIps];
}

/** Check whether a normalized host is blocked. */
export function isBlockedHost(
  connections: PeerConnections,
  host: string | undefined,
): boolean {
  const normalized = normalizeIpv4(host);
  return (
    !!normalized && connections.config().blockedIps.includes(normalized)
  );
}

function peerHosts(peer: Peer): Set<string> {
  const out = new Set<string>();
  const push = (host: string | undefined) => {
    const normalized = normalizeIpv4(host);
    if (normalized) out.add(normalized);
  };
  push(peer.socket.remoteAddress);
  const remote = parsePeer(peer.remoteLabel);
  if (remote) push(remote.host);
  const dialTarget = parsePeer(peer.dialTarget || "");
  if (dialTarget) push(dialTarget.host);
  if (peer.capabilities.listenIp) push(peer.capabilities.listenIp.host);
  return out;
}

function dropPeersMatchingIp(
  connections: PeerConnections,
  ip: string,
): number {
  let droppedPeers = 0;
  for (const peer of [...connections.peers.values()]) {
    if (!peerHosts(peer).has(ip)) continue;
    droppedPeers++;
    peer.socket.destroy(new Error(`blocked IP ${ip}`));
  }
  return droppedPeers;
}

/** Block an IPv4 host and drop its connections. */
export function blockIp(
  connections: PeerConnections,
  host: string,
): BlockIpResult {
  const ip = normalizeIpv4(host);
  if (!ip) throw new Error("expected IPv4 address");
  if (connections.config().blockedIps.includes(ip)) {
    return {
      ip,
      status: "already-blocked",
      droppedPeers: 0,
      removedKnownPeers: 0,
    };
  }
  connections.deps.updateConfig({
    blockedIps: unique([...connections.config().blockedIps, ip]),
  });
  const removedKnownPeers =
    connections.deps.discovery.pruneBlockedKnownPeers();
  const droppedPeers = dropPeersMatchingIp(connections, ip);
  return {
    ip,
    status: "blocked",
    droppedPeers,
    removedKnownPeers,
  };
}

/** Remove an IPv4 host from the block list. */
export function unblockIp(
  connections: PeerConnections,
  host: string,
): UnblockIpResult {
  const ip = normalizeIpv4(host);
  if (!ip) throw new Error("expected IPv4 address");
  if (!connections.config().blockedIps.includes(ip)) {
    return { ip, status: "not-blocked" };
  }
  connections.deps.updateConfig({
    blockedIps: connections
      .config()
      .blockedIps.filter((candidate) => candidate !== ip),
  });
  return { ip, status: "unblocked" };
}

/** Learn peer endpoints and local address observations. */
export function absorbHandshakeHeaders(
  connections: PeerConnections,
  headers: Record<string, string>,
  reporterHost?: string,
): void {
  connections.maybeAbsorbTryHeaders(headers, reporterHost);
  connections.deps.address.maybeObserveAdvertisedHost(
    headers,
    reporterHost,
  );
}

/** Check whether an endpoint is connected or being dialed. */
export function peerDialState(
  connections: PeerConnections,
  host: string,
  port: number,
): "connected" | "dialing" | "none" {
  const target = normalizePeer(host, port);
  if (connections.dialing.has(target)) return "dialing";
  for (const peer of connections.peers.values()) {
    if (peer.dialTarget === target) return "connected";
    if (
      peer.capabilities.listenIp &&
      normalizePeer(
        peer.capabilities.listenIp.host,
        peer.capabilities.listenIp.port,
      ) === target
    )
      return "connected";
  }
  return "none";
}

/** Validate an endpoint and report its connection outcome. */
export async function connectToPeer(
  connections: PeerConnections,
  peerSpec: string,
): Promise<ConnectPeerResult> {
  const addr = parsePeer(peerSpec);
  if (!addr) throw new Error("expected ip:port");
  const peer = normalizePeer(addr.host, addr.port);
  if (connections.deps.address.isSelfPeer(addr.host, addr.port))
    throw new Error("cannot add self as peer");
  if (connections.isBlockedHost(addr.host))
    return { peer, status: "blocked", message: `blocked IP ${addr.host}` };

  connections.deps.discovery.addKnownPeer(addr.host, addr.port);

  const state = connections.peerDialState(addr.host, addr.port);
  if (state === "connected") return { peer, status: "already-connected" };
  if (state === "dialing") return { peer, status: "dialing" };

  try {
    await connections.connectPeer(addr.host, addr.port);
    return { peer, status: "connected" };
  } catch (e) {
    return { peer, status: "saved", message: errMsg(e) };
  }
}

/** Return summaries of connected peers. */
export function getPeers(connections: PeerConnections): PeerInfo[] {
  return [...connections.peers.values()].map((peer) =>
    connections.peerInfo(peer),
  );
}
