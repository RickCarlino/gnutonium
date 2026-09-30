import {
  filterBlockedPeerState,
  peerStateEquals,
  peerStateTargets,
  rememberPeerInState,
  sortPeerStateEntries,
  trimPeerState,
} from "../config";
import {
  BOOTSTRAP_CONNECT_CONCURRENCY,
  BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR,
  MAX_PEER_AGE_SEC,
} from "../const";
import type { GWebCacheBootstrapState } from "../gwebcache_client";
import {
  isRoutableIpv4,
  normalizeIpv4,
  normalizePeer,
  parsePeer,
} from "../shared";
import type {
  GnutellaServentCollaborators,
  PeerState,
  RuntimeConfig,
} from "../types";
import { isAllowedPeerReferral } from "./addresses";
import { CacheAnnouncements } from "./gwebcache/announcements";

type DiscoveryPeer = {
  socket: { remoteAddress?: string };
  connectedAt: number;
  outbound?: boolean;
  dialTarget?: string;
  capabilities: { listenIp?: { host: string; port: number } };
};
type DiscoveryConfig = Pick<
  RuntimeConfig,
  | "blockedIps"
  | "peerSeenThresholdSec"
  | "gwebCaches"
  | "vendorCode"
  | "userAgent"
  | "maxLeafConnections"
  | "connectTimeoutMs"
>;
type DiscoveryDependencies =
  GnutellaServentCollaborators["bootstrapClient"] & {
    config: () => DiscoveryConfig;
    now: () => number;
    startedAtMs: () => number;
    scheduler: Pick<
      GnutellaServentCollaborators["scheduler"],
      "setTimeout" | "clearTimeout"
    >;
    isSelfPeer: (host: string, port: number) => boolean;
    isBlockedHost: (host: string) => boolean;
    peerCount: () => number;
    nodeMode: () => "leaf" | "ultrapeer";
    connectedLeafCount: () => number;
    connectedMeshPeerCount: () => number;
    availableDialSlots: () => number;
    isPeerBusy: (host: string, port: number) => boolean;
    connectPeer: (
      host: string,
      port: number,
      timeoutMs?: number,
    ) => Promise<void>;
    currentAdvertisedHost: () => string;
    currentAdvertisedPort: () => number;
    onError: (error: unknown) => void;
    persistCaches?: () => Promise<void>;
  };

/** Owns remembered peers and GWebCache bootstrap work. */
export class PeerDiscovery {
  knownPeers: PeerState;
  readonly gwebCacheBootstrapState: GWebCacheBootstrapState;
  private readonly announcements: CacheAnnouncements;
  private readonly abort = new AbortController();
  private acceptedInbound = false;
  private stopped = false;
  private connecting = false;
  private readonly failedPeers = new Set<string>();

  /** Copy remembered peers and attach discovery dependencies. */
  constructor(
    private readonly deps: DiscoveryDependencies,
    peers: PeerState,
  ) {
    this.knownPeers = { ...peers };
    this.gwebCacheBootstrapState = {
      registry: structuredClone(deps.config().gwebCaches),
    };
    this.announcements = new CacheAnnouncements({
      now: deps.now,
      connected: () => deps.peerCount() > 0,
      eligible: () =>
        deps.nodeMode() === "ultrapeer" && this.acceptedInbound,
      nextAnnouncementAt: () =>
        this.gwebCacheBootstrapState.nextAnnouncementAt ?? 0,
      send: () => this.sendCacheAnnouncement(),
      onError: deps.onError,
      scheduler: deps.scheduler,
    });
  }

  /** Return a copy of remembered peer timestamps. */
  snapshot(): PeerState {
    return { ...this.knownPeers };
  }

  /** Stop discovery announcements and cancel their timer. */
  dispose(): void {
    this.stopped = true;
    this.abort.abort();
    this.announcements.dispose();
  }

  /** Remove blocked endpoints and count the removals. */
  pruneBlockedKnownPeers(): number {
    const current = trimPeerState(this.knownPeers);
    const filtered = filterBlockedPeerState(
      current,
      this.deps.config().blockedIps,
    );
    const removedKnownPeers =
      peerStateTargets(current).length - peerStateTargets(filtered).length;
    if (peerStateEquals(current, filtered)) return 0;
    this.knownPeers = filtered;
    return removedKnownPeers;
  }

  private rememberKnownPeer(
    host: string,
    port: number,
    timestamp: number,
  ): void {
    if (!host || !port || this.deps.isSelfPeer(host, port)) return;
    if (this.deps.isBlockedHost(host)) return;
    if (this.failedPeers.has(normalizePeer(host, port))) return;
    this.knownPeers = rememberPeerInState(
      this.knownPeers,
      normalizePeer(host, port),
      timestamp,
    );
  }

  /** Remember a newly discovered endpoint. */
  addKnownPeer(host: string, port: number): void {
    this.rememberKnownPeer(host, port, 0);
  }

  /** Record a peer's most recent successful sighting. */
  updateKnownPeerLastSeen(
    host: string,
    port: number,
    timestamp?: number,
  ): void {
    this.failedPeers.delete(normalizePeer(host, port));
    this.rememberKnownPeer(
      host,
      port,
      timestamp ?? this.peerSeenTimestamp(),
    );
  }

  /** Convert the clock to nonnegative epoch seconds. */
  peerSeenTimestamp(nowMs = this.deps.now()): number {
    return Math.max(0, Math.floor(nowMs / 1000));
  }

  /** Remove stale or blocked peers and report changes. */
  pruneExpiredKnownPeers(nowSec?: number): boolean {
    const timestamp = nowSec ?? this.peerSeenTimestamp();
    const current = trimPeerState(this.knownPeers);
    const filtered = Object.fromEntries(
      sortPeerStateEntries(
        filterBlockedPeerState(current, this.deps.config().blockedIps),
      ).filter(
        ([, lastSeen]) =>
          lastSeen === 0 || timestamp - lastSeen <= MAX_PEER_AGE_SEC,
      ),
    ) as PeerState;
    if (peerStateEquals(current, filtered)) return false;
    this.knownPeers = filtered;
    return true;
  }

  /** Remember a peer's dial and advertised endpoints. */
  rememberPeerAddresses(peer: DiscoveryPeer, timestamp = 0): void {
    if (peer.outbound === false) this.acceptedInbound = true;
    const remembered = new Set<string>();
    const push = (host: string, port: number) => {
      const target = normalizePeer(host, port);
      if (remembered.has(target)) return;
      remembered.add(target);
      if (timestamp > 0)
        this.updateKnownPeerLastSeen(host, port, timestamp);
      else this.addKnownPeer(host, port);
    };

    if (peer.dialTarget) {
      const addr = parsePeer(peer.dialTarget);
      if (addr) push(addr.host, addr.port);
    }
    if (
      peer.capabilities.listenIp &&
      isAllowedPeerReferral(
        peer.capabilities.listenIp.host,
        peer.socket.remoteAddress,
      )
    ) {
      push(
        peer.capabilities.listenIp.host,
        peer.capabilities.listenIp.port,
      );
    }
  }

  /** Record sightings only after a stable connection. */
  markPeerSeenIfStable(
    peer: DiscoveryPeer,
    nowMs = this.deps.now(),
  ): void {
    if (
      nowMs - peer.connectedAt <
      this.deps.config().peerSeenThresholdSec * 1000
    )
      return;
    this.rememberPeerAddresses(peer, this.peerSeenTimestamp(nowMs));
  }

  /** Update the hourly announcement schedule after a connection change. */
  refreshGWebCacheReport(): void {
    this.announcements.refresh();
  }

  /** Attempt an announcement only if session eligibility and timing permit it. */
  async announceSelfToGWebCaches(): Promise<void> {
    await this.announcements.announce();
  }

  private async sendCacheAnnouncement(): Promise<void> {
    const host = normalizeIpv4(this.deps.currentAdvertisedHost());
    const port = this.deps.currentAdvertisedPort();
    if (!host || !isRoutableIpv4(host) || !port) return;

    await this.deps.reportSelfToGWebCaches({
      client: this.deps.config().vendorCode,
      version: this.deps.config().userAgent,
      ip: normalizePeer(host, port),
      uptimeSec: Math.max(
        0,
        Math.floor((this.deps.now() - this.deps.startedAtMs()) / 1000),
      ),
      leafCount:
        this.deps.nodeMode() === "ultrapeer"
          ? this.deps.connectedLeafCount()
          : undefined,
      maxLeaves:
        this.deps.nodeMode() === "ultrapeer"
          ? this.deps.config().maxLeafConnections
          : undefined,
      state: this.gwebCacheBootstrapState,
      now: this.deps.now,
      persist: this.deps.persistCaches,
      signal: this.abort.signal,
    });
  }

  /** List unblocked remembered endpoints by recency. */
  getKnownPeers(): string[] {
    return peerStateTargets(
      filterBlockedPeerState(
        this.knownPeers,
        this.deps.config().blockedIps,
      ),
    );
  }

  /** Fill available connection slots from discovery sources. */
  async connectKnownPeers(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      await this.connectCandidates();
    } finally {
      this.connecting = false;
    }
  }

  private async connectDiscoveredPeer(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<void> {
    if (this.stopped) throw new Error("discovery stopped");
    const target = normalizePeer(host, port);
    if (this.failedPeers.has(target))
      throw new Error(`peer ${target} already failed this session`);
    try {
      await this.deps.connectPeer(host, port, timeoutMs);
    } catch (error) {
      this.failedPeers.add(target);
      delete this.knownPeers[target];
      throw error;
    }
  }

  private async connectCandidates(): Promise<void> {
    this.pruneExpiredKnownPeers();
    const c = this.deps.config();
    const peers = this.getKnownPeers();
    const bootstrapTimeoutMs = Math.max(
      1,
      Math.floor(c.connectTimeoutMs / BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR),
    );
    await this.deps.connectBootstrapPeers({
      peers,
      client: c.vendorCode,
      version: c.userAgent,
      connectTimeoutMs: bootstrapTimeoutMs,
      connectConcurrency: BOOTSTRAP_CONNECT_CONCURRENCY,
      availableSlots: () =>
        this.stopped ? 0 : this.deps.availableDialSlots(),
      connectPeer: (host, port, timeoutMs) =>
        this.connectDiscoveredPeer(host, port, timeoutMs),
      addPeer: (peer) => {
        const addr = parsePeer(peer);
        if (!addr) return;
        this.addKnownPeer(addr.host, addr.port);
      },
      isSelfPeer: (host, port) => this.deps.isSelfPeer(host, port),
      canDialPeer: (host, port) =>
        !this.deps.isPeerBusy(host, port) &&
        !this.failedPeers.has(normalizePeer(host, port)) &&
        !this.deps.isBlockedHost(host),
      state: this.gwebCacheBootstrapState,
      now: this.deps.now,
      persist: this.deps.persistCaches,
      signal: this.abort.signal,
    });
  }
}
