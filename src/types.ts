import type { NetConnectOpts, Server, Socket } from "node:net";
import type { CacheState } from "./discovery/gwebcache/state";
import type {
  ConnectBootstrapOptions,
  ConnectBootstrapResult,
  ReportSelfOptions,
  ReportSelfResult,
} from "./discovery/gwebcache/types";
import type { RemoteQrpState as StandaloneRemoteQrpState } from "./routing/qrp";

type EventBase<T extends string> = { type: T; at: string };

type CliSearchResult = {
  resultNo: number;
  queryIdHex?: string;
  queryHops?: number;
  remoteHost: string;
  remotePort: number;
  speedKBps?: number;
  fileIndex?: number;
  fileSize: number;
  fileName: string;
  serventIdHex: string;
  viaPeerKey?: string;
  sha1Urn?: string;
  urns?: string[];
  metadata?: string[];
  vendorCode?: string;
  needsPush?: boolean;
  busy?: boolean;
};

type ShareSummary = {
  index: number;
  size: number;
  rel: string;
};

export type CliNode = {
  getPeers(): PeerInfo[];
  getResults(searchId: string): CliSearchResult[];
  getResult(resultNo: number): CliSearchResult;
  getShares(): ShareSummary[];
  getStatus(): NodeStatus;
};

export type ParsedCli = {
  config: string;
  exec: string[];
  command: string;
};

export type PeerAddr = { host: string; port: number };
export type PeerState = Record<string, number>;
export type Route = { peerKey: string; ts: number };
type NodeMode = "leaf" | "ultrapeer";
export type PeerRole = "leaf" | "ultrapeer";

export type RemoteQrpState = StandaloneRemoteQrpState;

export type PeerCapabilities = {
  version: string;
  headers: Record<string, string>;
  userAgent?: string;
  supportsGgep: boolean;
  supportsPongCaching: boolean;
  supportsBye: boolean;
  supportsCompression: boolean;
  supportsTls: boolean;
  compressIn: boolean;
  compressOut: boolean;
  isUltrapeer?: boolean;
  ultrapeerNeeded?: boolean;
  queryRoutingVersion?: string;
  ultrapeerQueryRoutingVersion?: string;
  dynamicQueryingVersion?: string;
  extProbesVersion?: string;
  degree?: number;
  isCrawler?: boolean;
  listenIp?: PeerAddr;
};

export type QueryDescriptor = {
  search: string;
  flagsRaw: number;
  requesterFirewalled: boolean;
  wantsXml: boolean;
  leafGuidedDynamic: boolean;
  ggepHAllowed: boolean;
  outOfBand: boolean;
  maxHits: number;
  urns: string[];
  xmlBlocks: string[];
  rawExtensions: Buffer;
};

type QueryHitResultDescriptor = {
  fileIndex: number;
  fileSize: number;
  fileName: string;
  urns: string[];
  metadata: string[];
  rawExtension: Buffer;
};

export type QueryHitDescriptor = {
  hits: number;
  port: number;
  ip: string;
  speedKBps: number;
  results: QueryHitResultDescriptor[];
  vendorCode?: string;
  openDataSize?: number;
  flagGgep?: boolean;
  flagBusy?: boolean;
  flagHaveUploaded?: boolean;
  flagUploadSpeedMeasured?: boolean;
  flagPush?: boolean;
  qhdPrivateArea?: Buffer;
  serventId: Buffer;
  serventIdHex: string;
};

export type ShareFile = {
  index: number;
  name: string;
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  sha1?: Buffer;
  sha1Urn?: string;
  keywords: string[];
};

export type SearchHit = {
  resultNo: number;
  queryIdHex: string;
  queryHops: number;
  remoteHost: string;
  remotePort: number;
  speedKBps: number;
  fileIndex: number;
  fileName: string;
  fileSize: number;
  serventIdHex: string;
  viaPeerKey: string;
  sha1Urn?: string;
  urns?: string[];
  metadata?: string[];
  vendorCode?: string;
  needsPush?: boolean;
  busy?: boolean;
};

type PendingPushTransferOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: { bytesCompleted: number }) => void;
};

export type PendingPush = {
  serventIdHex: string;
  result: SearchHit;
  destPath: string;
  transferOptions?: PendingPushTransferOptions;
  createdAt: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export type DownloadRecord = {
  at: string;
  fileName: string;
  bytes: number;
  host: string;
  port: number;
  mode: string;
  destPath: string;
};

export type ConfigDoc = {
  config: {
    listenHost: string;
    listenPort: number;
    advertisedHost?: string;
    advertisedPort?: number;
    blockedIps?: string[];
    gwebCaches?: CacheState;
    ultrapeer: boolean;
    maxConnections?: number;
    maxUltrapeerConnections?: number;
    maxLeafConnections?: number;
    maxTtl?: number;
    enableTls?: boolean;
    monitorIgnoreEvents?: string[];
    dataDir: string;
    downloadsDir?: string;
    incompleteDownloadsDir?: string;
    downloadQueueSize?: number;
    downloadMaxActivePerHost?: number;
    downloadRetryLimit?: number;
    downloadRetryBackoffSec?: number;
    downloadIdleTimeoutMs?: number;
    verifyDownloads?: boolean;
  };
  state: {
    serventIdHex: string;
    peers: PeerState;
  };
};

export type RuntimeConfig = {
  listenHost: string;
  listenPort: number;
  advertisedHost?: string;
  advertisedPort?: number;
  blockedIps: string[];
  gwebCaches: CacheState;
  ultrapeer: boolean;
  monitorIgnoreEvents: string[];
  nodeMode: NodeMode;
  dataDir: string;
  downloadsDir: string;
  incompleteDownloadsDir: string;
  downloadQueueSize: number;
  downloadMaxActivePerHost: number;
  downloadRetryLimit: number;
  downloadRetryBackoffSec: number;
  downloadIdleTimeoutMs: number;
  verifyDownloads: boolean;
  peerSeenThresholdSec: number;
  maxConnections: number;
  maxUltrapeerConnections: number;
  maxLeafConnections: number;
  connectTimeoutMs: number;
  pingIntervalSec: number;
  reconnectIntervalSec: number;
  rescanSharesSec: number;
  routeTtlSec: number;
  seenTtlSec: number;
  maxPayloadBytes: number;
  maxTtl: number;
  defaultPingTtl: number;
  defaultQueryTtl: number;
  advertisedSpeedKBps: number;
  downloadTimeoutMs: number;
  pushWaitMs: number;
  maxResultsPerQuery: number;
  userAgent: string;
  queryRoutingVersion: "0.1" | "0.2";
  enableCompression: boolean;
  enableQrp: boolean;
  enableBye: boolean;
  enablePongCaching: boolean;
  enableGgep: boolean;
  enableTls: boolean;
  serveUriRes: boolean;
  vendorCode: string;
};

export type PeerInfo = {
  key: string;
  remoteLabel: string;
  browseTarget?: string;
  role: PeerRole;
  outbound: boolean;
  dialTarget?: string;
  userAgent?: string;
  compression: boolean;
  tls: boolean;
};

export type NodeStatus = {
  peers: number;
  shares: number;
  results: number;
  knownPeers: number;
};

export type GnutellaEvent =
  | (EventBase<"STARTED"> & {
      listenHost: string;
      listenPort: number;
      advertisedHost: string;
      advertisedPort: number;
    })
  | (EventBase<"IDENTITY"> & {
      serventIdHex: string;
    })
  | (EventBase<"SHARES_REFRESHED"> & {
      count: number;
      totalKBytes: number;
    })
  | (EventBase<"MAINTENANCE_ERROR"> & {
      operation:
        | "SHARE_RESCAN"
        | "RECONNECT"
        | "SAVE"
        | "GWEBCACHE_UPDATE"
        | "DOWNLOAD_MANAGER";
      message: string;
    })
  | (EventBase<"PROBE_REJECTED"> & {
      message: string;
    })
  | (EventBase<"HANDSHAKE_DEBUG"> & {
      direction: "inbound" | "outbound";
      phase: string;
      peer: string;
      message: string;
    })
  | (EventBase<"PEER_CONNECTED"> & {
      peer: PeerInfo;
    })
  | (EventBase<"PEER_DROPPED"> & {
      peer: PeerInfo;
      message: string;
    })
  | (EventBase<"PEER_MESSAGE_RECEIVED"> & {
      peer: PeerInfo;
      payloadType: number;
      payloadTypeName: string;
      descriptorIdHex: string;
      ttl: number;
      hops: number;
      payloadLength: number;
    })
  | (EventBase<"PEER_MESSAGE_SENT"> & {
      peer: PeerInfo;
      payloadType: number;
      payloadTypeName: string;
      descriptorIdHex: string;
      ttl: number;
      hops: number;
      payloadLength: number;
    })
  | (EventBase<"PONG"> & {
      ip: string;
      port: number;
      files: number;
      kbytes: number;
    })
  | (EventBase<"QUERY_RECEIVED"> & {
      peer: PeerInfo;
      descriptorIdHex: string;
      ttl: number;
      hops: number;
      search: string;
      urns: string[];
    })
  | (EventBase<"QUERY_RESULT"> & {
      hit: SearchHit;
    })
  | (EventBase<"PUSH_REQUESTED"> & {
      fileIndex: number;
      fileName: string;
      ip: string;
      port: number;
    })
  | (EventBase<"PUSH_CALLBACK_FAILED"> & {
      message: string;
    })
  | (EventBase<"PUSH_UPLOAD_FAILED"> & {
      message: string;
    })
  | (EventBase<"DOWNLOAD_SUCCEEDED"> & {
      mode: "direct" | "push";
      resultNo: number;
      fileName: string;
      destPath: string;
      remoteHost: string;
      remotePort: number;
    })
  | (EventBase<"DOWNLOAD_QUEUED"> & {
      jobId: string;
      resultNo: number;
      fileName: string;
      destPath: string;
    })
  | (EventBase<"DOWNLOAD_STARTED"> & {
      jobId: string;
      fileName: string;
      remoteHost: string;
      remotePort: number;
    })
  | (EventBase<"DOWNLOAD_PAUSED"> & {
      jobId: string;
      fileName: string;
    })
  | (EventBase<"DOWNLOAD_RESUMED"> & {
      jobId: string;
      fileName: string;
    })
  | (EventBase<"DOWNLOAD_REMOVED"> & {
      jobId: string;
      fileName: string;
    })
  | (EventBase<"DOWNLOAD_FAILED"> & {
      jobId: string;
      fileName: string;
      message: string;
    })
  | (EventBase<"DOWNLOAD_VERIFICATION_FAILED"> & {
      jobId: string;
      fileName: string;
      destPath: string;
    })
  | (EventBase<"DOWNLOAD_DIRECT_FAILED"> & {
      resultNo: number;
      fileName: string;
      destPath: string;
      remoteHost: string;
      remotePort: number;
      message: string;
    })
  | (EventBase<"PING_SENT"> & {
      descriptorIdHex: string;
      ttl: number;
    })
  | (EventBase<"QUERY_SENT"> & {
      descriptorIdHex: string;
      ttl: number;
      search: string;
    })
  | (EventBase<"QUERY_SKIPPED"> & {
      reason: "NO_PEERS_CONNECTED";
    });

export type GnutellaEventListener = (event: GnutellaEvent) => void;
type NodeClock = {
  now: () => number;
};

type NodeScheduler = {
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout) => void;
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (timer: NodeJS.Timeout) => void;
  sleep: (ms: number) => Promise<void>;
};

type NodeNetFactory = {
  createConnection: (options: NetConnectOpts) => Socket;
  createServer: (listener: (socket: Socket) => void) => Server;
};

type NodeBootstrapClient = {
  connectBootstrapPeers: (
    options: ConnectBootstrapOptions,
  ) => Promise<ConnectBootstrapResult>;
  reportSelfToGWebCaches: (
    options: ReportSelfOptions,
  ) => Promise<ReportSelfResult>;
};

export type GnutellaServentCollaborators = {
  clock: NodeClock;
  scheduler: NodeScheduler;
  netFactory: NodeNetFactory;
  bootstrapClient: NodeBootstrapClient;
};

export type GnutellaServentCollaboratorOverrides = {
  clock?: Partial<NodeClock>;
  scheduler?: Partial<NodeScheduler>;
  netFactory?: Partial<NodeNetFactory>;
  bootstrapClient?: Partial<NodeBootstrapClient>;
};

export type GnutellaServentOptions = {
  onEvent?: GnutellaEventListener;
  runtimeConfig?: Partial<RuntimeConfig>;
  collaborators?: GnutellaServentCollaboratorOverrides;
};

export type ConnectPeerResult = {
  peer: string;
  status:
    | "connected"
    | "already-connected"
    | "dialing"
    | "saved"
    | "blocked";
  message?: string;
};

export type BlockIpResult = {
  ip: string;
  status: "blocked" | "already-blocked";
  droppedPeers: number;
  removedKnownPeers: number;
};

export type UnblockIpResult = {
  ip: string;
  status: "unblocked" | "not-blocked";
};

export type OwnerArguments<T extends unknown[]> = T extends [
  unknown,
  ...infer R,
]
  ? R
  : never;
