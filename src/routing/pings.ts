import type { PeerConnection as Peer } from "../connections/types";
import { TYPE } from "../const";
import { isAllowedPeerReferral } from "../discovery/addresses";
import { ts } from "../shared";
import { encodePong, parsePong } from "../wire/codec";
import type { DescriptorHeader } from "../wire/types";
import {
  overflowPongCacheKeys,
  pongCacheKey,
  pongReplyTtl,
  responseRouteDecision,
  selectCachedPongs,
} from "./descriptors";
import type { MessageRouter } from "./router";

type DiscoveryHeader = Pick<
  DescriptorHeader,
  "descriptorId" | "descriptorIdHex" | "ttl" | "hops"
>;

function isProbe(hdr: Pick<DiscoveryHeader, "ttl" | "hops">): boolean {
  return hdr.ttl === 1 && hdr.hops <= 1;
}

function isCrawler(hdr: Pick<DiscoveryHeader, "ttl" | "hops">): boolean {
  return hdr.ttl === 2 && hdr.hops === 0;
}

/** Remember the return route, answer, and possibly relay a ping. */
export function onPingDescriptor(
  router: MessageRouter,
  peer: Peer,
  hdr: DiscoveryHeader,
  payload: Buffer,
): void {
  if (hdr.ttl === 0) return;
  // Keepalive probes always get a self-pong. Limit discovery replies as well
  // as forwarding, including when this servent is a leaf.
  if (!isProbe(hdr)) {
    const state = router.peerState(peer);
    const now = router.now();
    if (state.lastPingAt !== undefined && now - state.lastPingAt < 1000)
      return;
    state.lastPingAt = now;
  }
  router.pingRoutes.set(hdr.descriptorIdHex, {
    peerKey: peer.key,
    ts: router.now(),
  });
  router.respondPong(peer, hdr);
  if (hdr.ttl <= 1 || !router.deps.transport.shouldRelayPings()) return;
  // Crawler pings ask about immediate neighbours, including leaves. Their
  // single self-pong replies travel back through this saved route.
  broadcastPingToPeers(
    router,
    hdr.descriptorId,
    hdr.ttl - 1,
    hdr.hops + 1,
    payload,
    peer.key,
    isCrawler(hdr),
  );
}

/** Learn from pongs even when their GUID has no outstanding request. */
export function onPong(
  router: MessageRouter,
  peer: Peer,
  hdr: DiscoveryHeader,
  payload: Buffer,
): void {
  const pong = parsePong(payload);
  if (
    !pong.port ||
    !isAllowedPeerReferral(pong.ip, peer.socket.remoteAddress)
  )
    return;
  router.cachePongPayload(peer, hdr.hops, payload);
  router.deps.discoveredPeer(pong.ip, pong.port);
  const decision = responseRouteDecision(
    router.pingRoutes.get(hdr.descriptorIdHex),
    { nodeMode: router.deps.transport.nodeMode() },
  );
  if (decision.kind === "drop") return;
  if (decision.kind === "local") {
    router.deps.emit({
      type: "PONG",
      at: ts(),
      ip: pong.ip,
      port: pong.port,
      files: pong.files,
      kbytes: pong.kbytes,
    });
    return;
  }
  if (hdr.ttl <= 1 || decision.route.peerKey === peer.key) return;
  router.forwardToRoute(
    decision.route,
    TYPE.PONG,
    hdr.descriptorId,
    hdr.ttl,
    hdr.hops,
    payload,
  );
}

/** Retain payload bytes, distance, and source for bounded cached replies. */
export function cachePongPayload(
  router: MessageRouter,
  peer: Peer,
  hops: number,
  payload: Buffer,
): void {
  router.pongCache.set(pongCacheKey(payload), {
    payload: Buffer.from(payload),
    at: router.now(),
    hops,
    sourcePeerKey: peer.key,
  });
  for (const key of overflowPongCacheKeys(
    router.pongCache.entries(),
    64,
  )) {
    router.pongCache.delete(key);
  }
}

/** Reply with local statistics and, for discovery, eligible cached pongs. */
export function respondPong(
  router: MessageRouter,
  peer: Peer,
  hdr: DiscoveryHeader,
): void {
  const ttl = pongReplyTtl(hdr.hops);
  const own = encodePong(
    router.deps.address.currentAdvertisedPort(),
    router.deps.address.currentAdvertisedHost(),
    router.deps.shares.list().length,
    router.deps.shares.totalSharedKBytes(),
  );
  router.deps.transport.sendToPeer(
    peer,
    TYPE.PONG,
    hdr.descriptorId,
    ttl,
    0,
    own,
  );
  if (
    hdr.ttl <= 1 ||
    isCrawler(hdr) ||
    router.deps.transport.nodeMode() === "leaf" ||
    !router.config().enablePongCaching
  )
    return;
  for (const entry of selectCachedPongs(
    router.pongCache.values(),
    1,
    10,
    peer.key,
    Math.min(255, router.config().maxTtl),
  )) {
    router.deps.transport.sendToPeer(
      peer,
      TYPE.PONG,
      hdr.descriptorId,
      ttl,
      entry.hops + 1,
      entry.payload,
    );
  }
}

/** Send pings to eligible peers, optionally excluding one. */
export function broadcastPingToPeers(
  router: MessageRouter,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
  exceptPeerKey?: string,
  includeLeaves = false,
): void {
  const skipLeaves =
    !includeLeaves && router.deps.transport.nodeMode() === "ultrapeer";
  const peers = [...router.deps.transport.peers.values()];
  for (const peer of peers) {
    const skipPeer = exceptPeerKey != null && peer.key === exceptPeerKey;
    const skipLeaf = skipLeaves && router.deps.transport.isLeafPeer(peer);
    if (skipPeer || skipLeaf) continue;
    router.deps.transport.sendToPeer(
      peer,
      TYPE.PING,
      descriptorId,
      ttl,
      hops,
      payload,
    );
  }
}
