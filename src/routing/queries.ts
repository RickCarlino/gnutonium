import type { PeerConnection as Peer } from "../connections/types";
import { TYPE } from "../const";
import type { QueryDescriptor } from "../types";
import { buildAggregateQrpTable, QrpTable } from "./qrp";
import {
  selectQueryRouteTargets,
  type QueryRouteCandidate,
} from "./query_selection";
import type { MessageRouter } from "./router";

const MAX_ULTRAPEER_QRP_TABLE_SIZE = 131072;

function buildAggregateUltrapeerQrp(router: MessageRouter): QrpTable {
  return buildAggregateQrpTable(
    router.qrpTable,
    [...router.deps.transport.peers.values()]
      .filter((peer) => router.deps.transport.isLeafPeer(peer))
      .map((peer) => router.peerState(peer).qrp),
    { maxTableSize: MAX_ULTRAPEER_QRP_TABLE_SIZE },
  );
}

/** Refresh QRP advertisements to eligible mesh peers. */
export function sendPublishedQrpToMeshPeers(router: MessageRouter): void {
  if (
    router.deps.transport.nodeMode() !== "ultrapeer" ||
    !router.config().enableQrp
  )
    return;
  for (const peer of router.deps.transport.peers.values()) {
    if (!router.deps.transport.isMeshPeer(peer)) continue;
    void router.sendQrpTable(peer).catch(() => void 0);
  }
}

/** Choose the local or aggregate QRP table to advertise. */
export function publishedQrpTableForPeer(
  router: MessageRouter,
  peer: Peer,
): QrpTable | undefined {
  if (!router.config().enableQrp) return undefined;
  if (router.deps.transport.nodeMode() === "ultrapeer") {
    if (!router.deps.transport.isMeshPeer(peer)) return undefined;
    if (!peer.capabilities.ultrapeerQueryRoutingVersion) return undefined;
    return buildAggregateUltrapeerQrp(router);
  }
  if (
    !(
      peer.capabilities.queryRoutingVersion ||
      peer.capabilities.ultrapeerQueryRoutingVersion
    )
  ) {
    return undefined;
  }
  return router.qrpTable;
}

function queryRouteCandidate(
  router: MessageRouter,
  peer: Peer,
): QueryRouteCandidate<string> {
  return {
    id: peer.key,
    role: router.deps.transport.isLeafPeer(peer) ? "leaf" : "mesh",
    remoteQrp: router.peerState(peer).qrp,
    supportsLastHopQrp:
      peer.role === "ultrapeer" &&
      !!peer.capabilities.ultrapeerQueryRoutingVersion,
  };
}

/** Forward original query bytes to selected recipients. */
export function routeQueryToPeers(
  router: MessageRouter,
  descriptorId: Buffer,
  logicalTtl: number,
  hops: number,
  payload: Buffer,
  q: QueryDescriptor,
  exceptPeerKey?: string,
  localOrigin = false,
): void {
  const peers = [...router.deps.transport.peers.values()].filter(
    (peer) => !exceptPeerKey || peer.key !== exceptPeerKey,
  );
  const peerByKey = new Map(peers.map((peer) => [peer.key, peer]));
  const targets = selectQueryRouteTargets({
    nodeMode: router.deps.transport.nodeMode(),
    enableQrp: router.config().enableQrp,
    query: q,
    candidates: peers.map((peer) => queryRouteCandidate(router, peer)),
    ttl: logicalTtl,
    hops,
    localOrigin,
  });
  for (const target of targets) {
    const peer = peerByKey.get(target.id);
    if (!peer) continue;
    // Relay the original bytes so unfamiliar query extensions survive.
    router.deps.transport.sendToPeer(
      peer,
      TYPE.QUERY,
      descriptorId,
      target.ttl,
      target.hops,
      payload,
    );
  }
}
