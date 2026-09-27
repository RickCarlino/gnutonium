import net from "node:net";
import path from "node:path";
import { trimPeerState, writeDoc } from "./config/document";
import { RuntimeConfiguration } from "./config/runtime";
import { PeerConnections } from "./connections/connections";
import { LocalAddress } from "./discovery/local_address";
import { PeerDiscovery } from "./discovery/runtime";
import { DownloadManager, type DownloadJob } from "./downloads";
import {
  connectBootstrapPeers,
  reportSelfToGWebCaches,
} from "./gwebcache_client";
import { MessageRouter } from "./routing/router";
import { SearchService } from "./search/service";
import type { SearchSession } from "./search/types";
import { ensureDir, errMsg, sleep, ts } from "./shared";
import { ShareLibrary } from "./shares/library";
import { TransferService } from "./transfers/service";
import type {
  BlockIpResult,
  ConfigDoc,
  ConnectPeerResult,
  DownloadRecord,
  GnutellaEvent,
  GnutellaEventListener,
  GnutellaServentCollaboratorOverrides,
  GnutellaServentCollaborators,
  GnutellaServentOptions,
  NodeStatus,
  PeerInfo,
  RuntimeConfig,
  SearchHit,
  ShareFile,
  UnblockIpResult,
} from "./types";
import { fromHex16 } from "./wire/ids";

type MaintenanceOperation =
  | "SHARE_RESCAN"
  | "RECONNECT"
  | "SAVE"
  | "GWEBCACHE_UPDATE"
  | "DOWNLOAD_MANAGER";

/** Composes the node and exposes its public actions. */
export class GnutellaServent {
  private configPath: string;
  private doc: ConfigDoc;
  private readonly configuration: RuntimeConfiguration;
  private collaborators: GnutellaServentCollaborators;
  private serventId: Buffer;
  protected readonly connections: PeerConnections;
  protected readonly shareLibrary: ShareLibrary;
  protected readonly router: MessageRouter;
  protected readonly search = new SearchService({
    emit: (event) => this.emitEvent(event),
    now: () => this.now(),
    sendQuery: (...args) => this.router.sendQuery(...args),
    browse: (...args) => this.transfers.browsePeer(...args),
    releaseQuery: (id) => this.router.queryRoutes.delete(id),
  });
  protected readonly downloadManager: DownloadManager;
  protected readonly transfers: TransferService;
  private timers: NodeJS.Timeout[] = [];
  private startedAtMs: number;
  private stopped = false;
  private listeners = new Set<GnutellaEventListener>();
  protected readonly discovery: PeerDiscovery;
  protected readonly localAddress = new LocalAddress(() => this.config());

  /** Copy configuration and connect the runtime services. */
  constructor(
    configPath: string,
    doc: ConfigDoc,
    options: GnutellaServentOptions = {},
  ) {
    this.configPath = path.resolve(configPath);
    this.doc = structuredClone(doc);
    this.configuration = new RuntimeConfiguration(
      this.configPath,
      this.doc,
      options.runtimeConfig || {},
    );
    this.doc.config = this.configuration.persistedConfig();
    this.collaborators = buildCollaborators(options.collaborators);
    this.connections = new PeerConnections({
      config: () => this.config(),
      updateConfig: (patch) => this.updateRuntimeConfig(patch),
      now: () => this.now(),
      emit: (event) => this.emitEvent(event),
      network: this.collaborators.netFactory,
      scheduler: this.collaborators.scheduler,
      address: this.localAddress,
      discovery: {
        addKnownPeer: (...args) => this.discovery.addKnownPeer(...args),
        getKnownPeers: () => this.discovery.getKnownPeers(),
        pruneBlockedKnownPeers: () =>
          this.discovery.pruneBlockedKnownPeers(),
        markPeerSeenIfStable: (peer) =>
          this.discovery.markPeerSeenIfStable(peer),
        refreshGWebCacheReport: () =>
          this.discovery.refreshGWebCacheReport(),
        rememberPeerAddresses: (peer) =>
          this.discovery.rememberPeerAddresses(peer),
      },
      ingress: {
        http: (socket, head, remaining) => {
          this.connections.releaseSocket(socket);
          this.transfers.startHttpSession(socket, head, remaining);
        },
        giv: (socket, head) => {
          this.connections.releaseSocket(socket);
          return this.transfers.handleIncomingGiv(socket, head);
        },
      },
      routing: {
        descriptor: (...args) => this.router.handleDescriptor(...args),
        ping: (ttl) => this.router.sendPing(ttl),
        publishQrp: (peer) => this.router.sendQrpTable(peer),
        dropped: (peer) => this.router.dropPeer(peer),
        bye: (...args) => this.router.sendBye(...args),
      },
    });
    this.discovery = new PeerDiscovery(
      {
        config: () => this.config(),
        persistCaches: async () => {
          this.syncCacheConfig();
          await ensureDir(path.dirname(this.configPath));
          await writeDoc(this.configPath, this.doc);
        },
        now: () => this.now(),
        startedAtMs: () => this.startedAtMs,
        scheduler: this.collaborators.scheduler,
        isSelfPeer: (host, port) =>
          this.localAddress.isSelfPeer(host, port),
        isBlockedHost: (host) => this.connections.isBlockedHost(host),
        peerCount: () => this.connections.peerCount(),
        nodeMode: () => this.connections.nodeMode(),
        connectedLeafCount: () => this.connections.connectedLeafCount(),
        connectedMeshPeerCount: () =>
          this.connections.connectedMeshPeerCount(),
        availableDialSlots: () => this.connections.availableDialSlots(),
        isPeerBusy: (host, port) =>
          this.connections.peerDialState(host, port) !== "none",
        connectPeer: (host, port, timeoutMs) =>
          this.connections.connectPeer(host, port, timeoutMs),
        currentAdvertisedHost: () =>
          this.localAddress.currentAdvertisedHost(),
        currentAdvertisedPort: () =>
          this.localAddress.currentAdvertisedPort(),
        connectBootstrapPeers: (options) =>
          this.collaborators.bootstrapClient.connectBootstrapPeers(
            options,
          ),
        reportSelfToGWebCaches: (options) =>
          this.collaborators.bootstrapClient.reportSelfToGWebCaches(
            options,
          ),
        onError: (error) =>
          this.emitMaintenanceError("GWEBCACHE_UPDATE", error),
      },
      this.doc.state.peers,
    );
    this.shareLibrary = new ShareLibrary({
      paths: () => this.config(),
      onCatalog: (shares) =>
        this.router.qrpTable.rebuildFromShares(shares),
      onRefresh: (count, totalKBytes) => {
        this.emitEvent({
          type: "SHARES_REFRESHED",
          at: ts(),
          count,
          totalKBytes,
        });
        if (this.config().enableQrp) {
          for (const peer of this.connections.peers.values()) {
            void this.router.sendQrpTable(peer).catch(() => void 0);
          }
        }
      },
      onError: (operation, error) =>
        this.emitMaintenanceError(operation, error),
    });
    this.startedAtMs = this.collaborators.clock.now();
    this.serventId = fromHex16(doc.state.serventIdHex);
    this.router = new MessageRouter({
      config: () => this.config(),
      now: () => this.now(),
      sleep: (ms) => this.sleep(ms),
      emit: (event) => this.emitEvent(event),
      serventId: this.serventId,
      address: this.localAddress,
      shares: this.shareLibrary,
      search: this.search,
      discoveredPeer: (...args) => this.discovery.addKnownPeer(...args),
      fulfillPush: (push) => this.transfers.fulfillPush(push),
      transport: this.connections,
    });
    this.transfers = new TransferService({
      config: () => this.config(),
      now: () => this.now(),
      emit: (event) => this.emitEvent(event),
      serventId: this.serventId,
      network: this.collaborators.netFactory,
      address: this.localAddress,
      shares: this.shareLibrary,
      router: this.router,
      connections: this.connections,
    });
    this.downloadManager = new DownloadManager({
      config: () => this.config(),
      now: () => this.now(),
      schedule: (delay, callback) =>
        this.collaborators.scheduler.setTimeout(callback, delay),
      cancel: (timer) => this.collaborators.scheduler.clearTimeout(timer),
      emit: (event) => this.emitEvent(event),
      onError: (error) =>
        this.emitMaintenanceError("DOWNLOAD_MANAGER", error),
      transfers: this.transfers,
    });
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  /** Load shares, listen, and start background maintenance. */
  async start(): Promise<void> {
    this.startedAtMs = this.now();
    const c = this.config();
    await this.refreshShares();
    await this.connections.startServer();
    await this.downloadManager.start();
    this.scheduleRecurringTask(
      c.rescanSharesSec * 1000,
      () => this.refreshShares(),
      "SHARE_RESCAN",
    );
    this.schedule(5000, () => this.pruneMaps());
    this.scheduleRecurringTask(
      c.reconnectIntervalSec * 1000,
      () => this.discovery.connectKnownPeers(),
      "RECONNECT",
    );
    this.schedule(c.pingIntervalSec * 1000, () =>
      this.sendPing(c.defaultPingTtl),
    );
    this.scheduleRecurringTask(15000, () => this.save(), "SAVE");
    this.emitEvent({
      type: "STARTED",
      at: ts(),
      listenHost: c.listenHost,
      listenPort: c.listenPort,
      advertisedHost: this.localAddress.currentAdvertisedHost(),
      advertisedPort: this.localAddress.currentAdvertisedPort(),
    });
    this.emitEvent({
      type: "IDENTITY",
      at: ts(),
      serventIdHex: this.serventId.toString("hex"),
    });
    void this.discovery
      .connectKnownPeers()
      .catch((e) => this.emitMaintenanceError("RECONNECT", e));
  }

  /** Stop background work and shut down runtime services. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.shareLibrary.dispose();
    this.clearTimers();
    await this.downloadManager.stop();
    this.transfers.stop();
    await this.connections.stop();
    this.router.dispose();
    await this.save();
  }

  /** Persist configuration, remembered peers, jobs, and shares. */
  async save(): Promise<void> {
    const c = this.config();
    for (const peer of this.connections.peers.values())
      this.discovery.markPeerSeenIfStable(peer);
    this.discovery.pruneExpiredKnownPeers();
    this.discovery.pruneBlockedKnownPeers();
    this.doc.state = {
      peers: trimPeerState(this.discovery.snapshot()),
      serventIdHex: this.serventId.toString("hex"),
    };
    this.syncCacheConfig();
    await ensureDir(path.dirname(this.configPath));
    await ensureDir(c.downloadsDir);
    await ensureDir(c.incompleteDownloadsDir);
    await writeDoc(this.configPath, this.doc);
    await this.downloadManager.persist();
    await this.shareLibrary.persistShareIndex();
  }

  private syncCacheConfig(): void {
    const gwebCaches = this.discovery.gwebCacheBootstrapState.registry;
    if (gwebCaches) this.configuration.update({ gwebCaches });
    this.doc.config = this.configuration.persistedConfig();
  }

  /** Return a detached snapshot of runtime settings. */
  config(): RuntimeConfig {
    return this.configuration.snapshot();
  }

  /** Apply runtime overrides and return updated settings. */
  updateRuntimeConfig(patch: Partial<RuntimeConfig>): RuntimeConfig {
    if (patch.gwebCaches)
      this.discovery.gwebCacheBootstrapState.registry = structuredClone(
        patch.gwebCaches,
      );
    const result = this.configuration.update(patch);
    this.doc.config = this.configuration.persistedConfig();
    return result;
  }

  /** Register an event listener and return its unsubscribe action. */
  subscribe(listener: GnutellaEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Summarize peer, share, result, and discovery counts. */
  getStatus(): NodeStatus {
    return {
      peers: this.connections.peers.size,
      shares: this.shareLibrary.shares.length,
      results: this.search.resultCount,
      knownPeers: this.getKnownPeers().length,
    };
  }

  /** Return this node's hexadecimal servent identity. */
  getServentIdHex(): string {
    return this.serventId.toString("hex");
  }

  /** Validate an endpoint and report its connection outcome. */
  connectToPeer(peerSpec: string): Promise<ConnectPeerResult> {
    return this.connections.connectToPeer(peerSpec);
  }

  /** Return summaries of connected peers. */
  getPeers(): PeerInfo[] {
    return this.connections.getPeers();
  }

  /** List unblocked remembered endpoints by recency. */
  getKnownPeers(): string[] {
    return this.discovery.getKnownPeers();
  }

  /** Return the configured blocked IPv4 addresses. */
  getBlockedIps(): string[] {
    return this.connections.getBlockedIps();
  }

  /** Block an IPv4 host and drop its connections. */
  blockIp(host: string): BlockIpResult {
    return this.connections.blockIp(host);
  }

  /** Remove an IPv4 host from the block list. */
  unblockIp(host: string): UnblockIpResult {
    return this.connections.unblockIp(host);
  }

  /** Rescan shared files and refresh the published catalog. */
  refreshShares(): Promise<void> {
    return this.shareLibrary.refreshShares();
  }

  /** Return detached copies of local shared files. */
  getShares(): ShareFile[] {
    return this.shareLibrary.list();
  }

  /** Originate a ping and remember its local return route. */
  sendPing(ttl: number): void {
    return this.router.sendPing(ttl);
  }

  /** Originate a text or URN query and track its replies. */
  sendQuery(search: string, ttl?: number): SearchSession | undefined {
    return this.search.query(search, ttl);
  }

  /** Fetch a peer's shared-file listing into a separate search session. */
  browsePeer(target: string): Promise<SearchSession> {
    return this.search.browse(target);
  }

  /** Return detached results for one explicit search session. */
  getResults(searchId: string): SearchHit[] {
    return this.search.snapshot(searchId);
  }

  /** Resolve a stable result number across all open sessions. */
  getResult(resultNo: number): SearchHit {
    return this.search.resolve(resultNo);
  }

  /** Remove one or all searches and their results. */
  clearResults(searchId?: string): void {
    this.search.clear(searchId);
  }

  /** List independent query and browse sessions. */
  getSearches(): SearchSession[] {
    return this.search.list();
  }

  /** Queue a numbered result for managed downloading. */
  downloadResult(
    resultNo: number,
    destOverride?: string,
  ): Promise<DownloadJob> {
    return this.queueDownloadResult(resultNo, destOverride);
  }

  /** Resolve a search result and create or update its job. */
  async queueDownloadResult(
    resultNo: number,
    destOverride?: string,
  ): Promise<DownloadJob> {
    return await this.downloadManager.queue(
      this.search.resolve(resultNo),
      destOverride,
    );
  }

  /** Pause a managed job and abort its active transfer. */
  async pauseDownload(jobId: string): Promise<DownloadJob> {
    return await this.downloadManager.pause(jobId);
  }

  /** Reset retries and requeue an unfinished download. */
  async resumeDownload(jobId: string): Promise<DownloadJob> {
    return await this.downloadManager.resume(jobId);
  }

  /** Forget a managed job and delete its incomplete file. */
  async removeDownload(jobId: string): Promise<void> {
    await this.downloadManager.remove(jobId);
  }

  /** Return detached snapshots of managed download jobs. */
  getDownloadJobs(): DownloadJob[] {
    return this.downloadManager.getJobs();
  }

  /** Return completed transfer history for this process. */
  getDownloads(): DownloadRecord[] {
    return this.downloadManager.getHistory();
  }

  private emitEvent(event: GnutellaEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  protected emitMaintenanceError(
    operation: MaintenanceOperation,
    e: unknown,
  ): void {
    this.emitEvent({
      type: "MAINTENANCE_ERROR",
      at: ts(),
      operation,
      message: errMsg(e),
    });
  }

  protected now(): number {
    return this.collaborators.clock.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.collaborators.scheduler.sleep(ms);
  }

  protected schedule(ms: number, fn: () => void): void {
    this.timers.push(this.collaborators.scheduler.setInterval(fn, ms));
  }

  private scheduleRecurringTask(
    ms: number,
    task: () => Promise<void>,
    operation: MaintenanceOperation,
  ): void {
    this.schedule(
      ms,
      () =>
        void task().catch((e) => this.emitMaintenanceError(operation, e)),
    );
  }

  protected pruneMaps(): void {
    const now = this.now();
    this.router.prune();
    this.transfers.prunePendingPushQueues(now, this.config().pushWaitMs);
    this.search.prune();
  }

  private clearTimers(): void {
    for (const t of this.timers)
      this.collaborators.scheduler.clearInterval(t);
    this.timers = [];
    this.discovery.dispose();
  }
}

function defaultCollaborators(): GnutellaServentCollaborators {
  return {
    clock: {
      now: () => Date.now(),
    },
    scheduler: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (timer) => clearTimeout(timer),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (timer) => clearInterval(timer),
      sleep,
    },
    netFactory: {
      createConnection: (options) => net.createConnection(options),
      createServer: (listener) => net.createServer(listener),
    },
    bootstrapClient: {
      connectBootstrapPeers,
      reportSelfToGWebCaches,
    },
  };
}

function buildCollaborators(
  overrides?: GnutellaServentCollaboratorOverrides,
): GnutellaServentCollaborators {
  const defaults = defaultCollaborators();
  return {
    clock: { ...defaults.clock, ...overrides?.clock },
    scheduler: { ...defaults.scheduler, ...overrides?.scheduler },
    netFactory: { ...defaults.netFactory, ...overrides?.netFactory },
    bootstrapClient: {
      ...defaults.bootstrapClient,
      ...overrides?.bootstrapClient,
    },
  };
}
