import type { PeerConnections } from "../connections/connections";
import type { PeerConnection as Peer } from "../connections/types";
import { LOCAL_ROUTE, TYPE } from "../const";
import type { LocalAddress } from "../discovery/local_address";
import type { SearchService } from "../search/service";
import type { ShareLibrary } from "../shares/library";
import type {
  GnutellaEvent,
  OwnerArguments,
  RemoteQrpState,
  Route,
  RuntimeConfig,
  SearchHit,
} from "../types";
import type { parsePush } from "../wire/codec";
import { encodePush, parseQueryHit } from "../wire/codec";
import { randomId16, rawHex16 } from "../wire/ids";
import type { DescriptorHeader } from "../wire/types";
import type { PongCacheEntry } from "./descriptors/types";
import * as messages from "./messages";
import * as origin from "./origin";
import * as pings from "./pings";
import { initialRemoteQrpState, QrpTable } from "./qrp";
import * as qrp from "./qrp_exchange";
import { QrpPublisher } from "./qrp_publication";
import * as query from "./queries";
import * as state from "./state";

type RouterDependencies = {
  config: () => RuntimeConfig;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  emit: (event: GnutellaEvent) => void;
  serventId: Buffer;
  address: Pick<
    LocalAddress,
    "currentAdvertisedHost" | "currentAdvertisedPort"
  >;
  shares: Pick<ShareLibrary, "list" | "matches" | "totalSharedKBytes">;
  search: Pick<SearchService, "ingest">;
  discoveredPeer: (host: string, port: number) => void;
  fulfillPush: (push: ReturnType<typeof parsePush>) => Promise<void>;
  transport: Pick<
    PeerConnections,
    | "peers"
    | "isLeafPeer"
    | "isMeshPeer"
    | "nodeMode"
    | "sendToPeer"
    | "peerInfo"
    | "shouldRelayPings"
    | "shouldRelayQueries"
  >;
};
/** Owns descriptor dispatch, return routes, and QRP exchange. */
export class MessageRouter {
  readonly seen = new Map<string, number>();
  readonly pingRoutes = new Map<string, Route | typeof LOCAL_ROUTE>();
  readonly queryRoutes = new Map<string, Route | typeof LOCAL_ROUTE>();
  readonly pushRoutes = new Map<string, Route>();
  qrpTable = new QrpTable();
  private readonly qrpPublisher: QrpPublisher;
  readonly pongCache = new Map<string, PongCacheEntry>();
  private readonly peerRouting = new Map<
    string,
    { qrp: RemoteQrpState; lastPingAt: number | undefined }
  >();

  /** Attach routing, transport, and local-content dependencies. */
  constructor(readonly deps: RouterDependencies) {
    this.qrpPublisher = new QrpPublisher({
      tableForPeer: (peer) => this.publishedQrpTableForPeer(peer),
      maxPayloadBytes: () => this.config().maxPayloadBytes,
      sleep: (ms) => this.sleep(ms),
      send: (peer, payload) =>
        deps.transport.sendToPeer(
          peer,
          TYPE.ROUTE_TABLE_UPDATE,
          this.randomId16(),
          1,
          0,
          payload,
        ),
    });
  }

  /** Apply routing guards before dispatching a descriptor. */
  handleDescriptor(
    ...args: OwnerArguments<Parameters<typeof messages.handleDescriptor>>
  ): ReturnType<typeof messages.handleDescriptor> {
    return messages.handleDescriptor(this, ...args);
  }

  /** Originate a ping and remember its local return route. */
  sendPing(
    ...args: OwnerArguments<Parameters<typeof origin.sendPing>>
  ): ReturnType<typeof origin.sendPing> {
    return origin.sendPing(this, ...args);
  }

  /** Originate a text or URN query and track its replies. */
  sendQuery(
    ...args: OwnerArguments<Parameters<typeof origin.sendQuery>>
  ): ReturnType<typeof origin.sendQuery> {
    return origin.sendQuery(this, ...args);
  }

  /** Record browsed hits and their push route; return the count. */
  ingestBrowse(
    peer: Peer,
    header: Pick<
      DescriptorHeader,
      "descriptorId" | "descriptorIdHex" | "payloadType" | "ttl" | "hops"
    >,
    payload: Buffer,
  ): number {
    const packet = parseQueryHit(payload);
    this.pushRoutes.set(packet.serventIdHex, {
      peerKey: peer.key,
      ts: this.now(),
    });
    this.deps.search.ingest(
      {
        queryIdHex: header.descriptorIdHex,
        queryHops: header.hops,
        viaPeerKey: peer.key,
      },
      packet,
    );
    return packet.results.length;
  }

  /** Validate a push route and return a callback that sends it. */
  preparePush(hit: SearchHit): () => void {
    const route = this.pushRoutes.get(hit.serventIdHex);
    if (!route) throw new Error("no push route for servent");
    const peer = this.deps.transport.peers.get(route.peerKey);
    if (!peer) throw new Error("push route peer not connected");
    const payload = encodePush(
      rawHex16(hit.serventIdHex),
      hit.fileIndex,
      this.deps.address.currentAdvertisedHost(),
      this.deps.address.currentAdvertisedPort(),
    );
    const id = this.randomId16();
    return () =>
      this.deps.transport.sendToPeer(
        peer,
        TYPE.PUSH,
        id,
        Math.max(1, hit.queryHops + 2),
        0,
        payload,
      );
  }

  /** Get or initialize a peer's QRP and ping state. */
  peerState(peer: Peer): {
    qrp: RemoteQrpState;
    lastPingAt: number | undefined;
  } {
    let state = this.peerRouting.get(peer.key);
    if (!state) {
      state = { qrp: initialRemoteQrpState(), lastPingAt: undefined };
      this.peerRouting.set(peer.key, state);
    }
    return state;
  }

  /** Discard peer routing state and refresh aggregate QRP. */
  dropPeer(peer: Peer): void {
    this.qrpPublisher.drop(peer);
    const hadLeafQrp =
      peer.role === "leaf" && !!this.peerRouting.get(peer.key)?.qrp.table;
    this.peerRouting.delete(peer.key);
    if (hadLeafQrp) this.sendPublishedQrpToMeshPeers();
  }

  /** Expire deduplication entries, return routes, and pongs. */
  prune(): void {
    const now = this.now();
    const config = this.config();
    const routeAge = config.routeTtlSec * 1000;
    this.pruneSeenEntries(now, config.seenTtlSec * 1000);
    this.pruneRouteEntries(this.pingRoutes, now, routeAge);
    this.pruneRouteEntries(this.queryRoutes, now, routeAge);
    this.prunePushRoutes(now, routeAge);
    this.prunePongCache(now, routeAge);
  }

  /** Clear peer routing state and all routing caches. */
  dispose(): void {
    this.qrpPublisher.dispose();
    this.peerRouting.clear();
    this.seen.clear();
    this.pingRoutes.clear();
    this.queryRoutes.clear();
    this.pushRoutes.clear();
    this.pongCache.clear();
  }

  /** Read the current runtime configuration. */
  config(): RuntimeConfig {
    return this.deps.config();
  }

  /** Read the injected clock in milliseconds. */
  now(): number {
    return this.deps.now();
  }

  /** Wait for the requested number of milliseconds. */
  sleep(ms: number): Promise<void> {
    return this.deps.sleep(ms);
  }

  /** Generate a random GUID with Gnutella marker bytes. */
  randomId16(): Buffer {
    return randomId16();
  }

  /** Record a descriptor's deduplication key and arrival time. */
  markSeen(
    ...args: OwnerArguments<Parameters<typeof state.markSeen>>
  ): ReturnType<typeof state.markSeen> {
    return state.markSeen(this, ...args);
  }

  /** Check whether a descriptor's deduplication key is known. */
  hasSeen(
    ...args: OwnerArguments<Parameters<typeof state.hasSeen>>
  ): ReturnType<typeof state.hasSeen> {
    return state.hasSeen(this, ...args);
  }

  /** Remove expired descriptor deduplication entries. */
  pruneSeenEntries(
    ...args: OwnerArguments<Parameters<typeof state.pruneSeenEntries>>
  ): ReturnType<typeof state.pruneSeenEntries> {
    return state.pruneSeenEntries(this, ...args);
  }

  /** Remove expired forwarding routes, preserving local routes. */
  pruneRouteEntries(
    ...args: OwnerArguments<Parameters<typeof state.pruneRouteEntries>>
  ): ReturnType<typeof state.pruneRouteEntries> {
    return state.pruneRouteEntries(this, ...args);
  }

  /** Remove expired servent-to-peer push routes. */
  prunePushRoutes(
    ...args: OwnerArguments<Parameters<typeof state.prunePushRoutes>>
  ): ReturnType<typeof state.prunePushRoutes> {
    return state.prunePushRoutes(this, ...args);
  }

  /** Remove expired cached pong payloads. */
  prunePongCache(
    ...args: OwnerArguments<Parameters<typeof state.prunePongCache>>
  ): ReturnType<typeof state.prunePongCache> {
    return state.prunePongCache(this, ...args);
  }

  /** Forward along a saved route with updated TTL and hops. */
  forwardToRoute(
    ...args: OwnerArguments<Parameters<typeof messages.forwardToRoute>>
  ): ReturnType<typeof messages.forwardToRoute> {
    return messages.forwardToRoute(this, ...args);
  }

  /** Send a descriptor to every peer except an optional exclusion. */
  broadcast(
    ...args: OwnerArguments<Parameters<typeof messages.broadcast>>
  ): ReturnType<typeof messages.broadcast> {
    return messages.broadcast(this, ...args);
  }

  /** Route an originating query using its encoded payload. */
  broadcastQuery(
    ...args: OwnerArguments<Parameters<typeof messages.broadcastQuery>>
  ): ReturnType<typeof messages.broadcastQuery> {
    return messages.broadcastQuery(this, ...args);
  }

  /** Clamp query lifetime or reject invalid TTL and hops. */
  normalizeQueryLifetime(
    ...args: OwnerArguments<
      Parameters<typeof messages.normalizeQueryLifetime>
    >
  ): ReturnType<typeof messages.normalizeQueryLifetime> {
    return messages.normalizeQueryLifetime(this, ...args);
  }

  /** Recognize a one-hop request for the full share index. */
  isIndexQuery(
    ...args: OwnerArguments<Parameters<typeof messages.isIndexQuery>>
  ): ReturnType<typeof messages.isIndexQuery> {
    return messages.isIndexQuery(this, ...args);
  }

  /** Reject empty or trivial searches except valid index queries. */
  shouldIgnoreQuery(
    ...args: OwnerArguments<Parameters<typeof messages.shouldIgnoreQuery>>
  ): ReturnType<typeof messages.shouldIgnoreQuery> {
    return messages.shouldIgnoreQuery(this, ...args);
  }

  /** Cache a pong and evict entries beyond capacity. */
  cachePongPayload(
    ...args: OwnerArguments<Parameters<typeof pings.cachePongPayload>>
  ): ReturnType<typeof pings.cachePongPayload> {
    return pings.cachePongPayload(this, ...args);
  }

  /** Check duplicate and closing-peer suppression rules. */
  shouldIgnoreDescriptor(
    ...args: OwnerArguments<
      Parameters<typeof messages.shouldIgnoreDescriptor>
    >
  ): ReturnType<typeof messages.shouldIgnoreDescriptor> {
    return messages.shouldIgnoreDescriptor(this, ...args);
  }

  /** Disconnect a leaf that relays another node's traffic. */
  rejectRelayedLeafDescriptor(
    ...args: OwnerArguments<
      Parameters<typeof messages.rejectRelayedLeafDescriptor>
    >
  ): ReturnType<typeof messages.rejectRelayedLeafDescriptor> {
    return messages.rejectRelayedLeafDescriptor(this, ...args);
  }

  /** Remember the return route, answer, and possibly relay a ping. */
  onPingDescriptor(
    ...args: OwnerArguments<Parameters<typeof pings.onPingDescriptor>>
  ): ReturnType<typeof pings.onPingDescriptor> {
    return pings.onPingDescriptor(this, ...args);
  }

  /** Answer a query locally and relay it when allowed. */
  onQueryDescriptor(
    ...args: OwnerArguments<Parameters<typeof messages.onQueryDescriptor>>
  ): ReturnType<typeof messages.onQueryDescriptor> {
    return messages.onQueryDescriptor(this, ...args);
  }

  /** Invoke the handler for a descriptor's payload type. */
  dispatchDescriptor(
    ...args: OwnerArguments<Parameters<typeof messages.dispatchDescriptor>>
  ): ReturnType<typeof messages.dispatchDescriptor> {
    return messages.dispatchDescriptor(this, ...args);
  }

  /** Send a disconnect notice and mark the peer as closing. */
  sendBye(
    ...args: OwnerArguments<Parameters<typeof messages.sendBye>>
  ): ReturnType<typeof messages.sendBye> {
    return messages.sendBye(this, ...args);
  }

  /** Reply with local statistics and eligible cached pongs. */
  respondPong(
    ...args: OwnerArguments<Parameters<typeof pings.respondPong>>
  ): ReturnType<typeof pings.respondPong> {
    return pings.respondPong(this, ...args);
  }

  /** Send bounded batches of matching local shares. */
  respondQueryHit(
    ...args: OwnerArguments<Parameters<typeof messages.respondQueryHit>>
  ): ReturnType<typeof messages.respondQueryHit> {
    return messages.respondQueryHit(this, ...args);
  }

  /** Cache a discovered endpoint and deliver or forward its pong. */
  onPong(
    ...args: OwnerArguments<Parameters<typeof pings.onPong>>
  ): ReturnType<typeof pings.onPong> {
    return pings.onPong(this, ...args);
  }

  /** Remember the push route and deliver or forward hits. */
  onQueryHit(
    ...args: OwnerArguments<Parameters<typeof messages.onQueryHit>>
  ): ReturnType<typeof messages.onQueryHit> {
    return messages.onQueryHit(this, ...args);
  }

  /** Fulfill a local push request or forward it toward its owner. */
  onPush(
    ...args: OwnerArguments<Parameters<typeof messages.onPush>>
  ): ReturnType<typeof messages.onPush> {
    return messages.onPush(this, ...args);
  }

  /** Consume a disconnect notice and end the peer socket. */
  onBye(
    ...args: OwnerArguments<Parameters<typeof messages.onBye>>
  ): ReturnType<typeof messages.onBye> {
    return messages.onBye(this, ...args);
  }

  /** Validate and apply a peer's QRP reset or patch. */
  onRouteTableUpdate(
    ...args: OwnerArguments<Parameters<typeof qrp.onRouteTableUpdate>>
  ): ReturnType<typeof qrp.onRouteTableUpdate> {
    return qrp.onRouteTableUpdate(this, ...args);
  }

  /** Advertise QRP once per connection and whenever the table changes. */
  sendQrpTable(peer: Peer): Promise<void> {
    return this.qrpPublisher.send(peer);
  }

  /** Refresh QRP advertisements to eligible mesh peers. */
  sendPublishedQrpToMeshPeers(
    ...args: OwnerArguments<
      Parameters<typeof query.sendPublishedQrpToMeshPeers>
    >
  ): ReturnType<typeof query.sendPublishedQrpToMeshPeers> {
    return query.sendPublishedQrpToMeshPeers(this, ...args);
  }

  /** Choose the local or aggregate QRP table to advertise. */
  publishedQrpTableForPeer(
    ...args: OwnerArguments<
      Parameters<typeof query.publishedQrpTableForPeer>
    >
  ): ReturnType<typeof query.publishedQrpTableForPeer> {
    return query.publishedQrpTableForPeer(this, ...args);
  }

  /** Forward original query bytes to selected recipients. */
  routeQueryToPeers(
    ...args: OwnerArguments<Parameters<typeof query.routeQueryToPeers>>
  ): ReturnType<typeof query.routeQueryToPeers> {
    return query.routeQueryToPeers(this, ...args);
  }

  /** Send pings to eligible peers, optionally excluding one. */
  broadcastPingToPeers(
    ...args: OwnerArguments<Parameters<typeof pings.broadcastPingToPeers>>
  ): ReturnType<typeof pings.broadcastPingToPeers> {
    return pings.broadcastPingToPeers(this, ...args);
  }
}
