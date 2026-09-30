import type { PeerConnection as Peer } from "../connections/types";
import { LOCAL_ROUTE, TYPE } from "../const";
import { splitQuerySearch } from "../search/query";
import { ts } from "../shared";
import { encodeQuery } from "../wire/codec";
import { parseMagnetUri } from "../wire/magnet";
import type { MessageRouter } from "./router";

/** Originate a ping and remember its local return route. */
export function sendPing(
  router: MessageRouter,
  ttl: number,
  target?: Peer,
): void {
  if (!router.deps.transport.peers.size) return;
  if (target && router.deps.transport.peers.get(target.key) !== target)
    return;
  const descriptorId = router.randomId16();
  const hex = descriptorId.toString("hex");
  router.markSeen(TYPE.PING, hex);
  router.pingRoutes.set(hex, LOCAL_ROUTE);
  const pingTtl = Math.max(0, Math.min(ttl, router.config().maxTtl));
  const peers = target ? [target] : router.deps.transport.peers.values();
  for (const peer of peers) {
    if (
      !target &&
      router.deps.transport.nodeMode() === "ultrapeer" &&
      router.deps.transport.isLeafPeer(peer)
    )
      continue;
    router.deps.transport.sendToPeer(
      peer,
      TYPE.PING,
      descriptorId,
      pingTtl,
      0,
      Buffer.alloc(0),
    );
  }
  router.deps.emit({
    type: "PING_SENT",
    at: ts(),
    descriptorIdHex: hex,
    ttl,
  });
}

/** Originate a text or URN query and track its replies. */
export function sendQuery(
  router: MessageRouter,
  descriptorId: Buffer,
  search: string,
  ttl = router.config().defaultQueryTtl,
): boolean {
  if (!router.deps.transport.peers.size) {
    router.deps.emit({
      type: "QUERY_SKIPPED",
      at: ts(),
      reason: "NO_PEERS_CONNECTED",
    });
    return false;
  }

  const hex = descriptorId.toString("hex");
  router.markSeen(TYPE.QUERY, hex);
  router.queryRoutes.set(hex, LOCAL_ROUTE);
  const query = splitOutgoingQuery(search);
  const payload = encodeQuery(query.search, {
    ggepHAllowed: !!router.config().enableGgep,
    maxHits: Math.min(0x1ff, router.config().maxResultsPerQuery),
    urns: query.urns,
  });
  router.broadcastQuery(
    descriptorId,
    Math.min(router.config().maxTtl, ttl),
    0,
    payload,
    search,
  );
  router.deps.emit({
    type: "QUERY_SENT",
    at: ts(),
    descriptorIdHex: hex,
    ttl,
    search,
  });
  return true;
}
type OutgoingQueryParts = {
  search: string;
  urns: string[];
};
function splitOutgoingQuery(search: string): OutgoingQueryParts {
  const magnet = parseMagnetUri(search);
  if (magnet) {
    return {
      search: magnet.search || "",
      urns: magnet.urns,
    };
  }
  return splitQuerySearch(search);
}
