import type { CacheState } from "./state";

type GWebCacheMode = "get" | "update";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type GWebCacheRequestOptions = {
  mode?: GWebCacheMode;
  network?: "gnutella" | "gnutella2";
  client?: string;
  version?: string;
  ping?: boolean;
  spec?: 2;
  ip?: string;
  url?: string;
  cluster?: string;
  leafCount?: number;
  maxLeaves?: number;
  uptimeSec?: number;
  getLeaves?: boolean;
  getClusters?: boolean;
  getVendors?: boolean;
  getUptime?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Explicit transport override for tests; bypasses public-address checks. */
  fetchImpl?: FetchLike;
};

export type GWebCacheInfoLine = {
  key: string;
  values: string[];
};

export type GWebCachePong = {
  name: string;
  networks: string[];
};

export type GWebCacheUpdate = {
  ok: boolean;
  warning?: string;
  values: string[];
};

export type GWebCacheHostEntry = {
  peer: string;
  ageSec?: number;
  cluster?: string;
  leafCount?: number;
  vendor?: string;
  uptimeSec?: number;
  extraFields: string[];
};

export type GWebCacheCacheEntry = {
  url: string;
  ageSec?: number;
};

export type GWebCacheResponse = {
  spec?: 2;
  rawLines: string[];
  peers: string[];
  caches: string[];
  warnings: string[];
  info: GWebCacheInfoLine[];
  hostEntries: GWebCacheHostEntry[];
  cacheEntries: GWebCacheCacheEntry[];
  pong?: GWebCachePong;
  update?: GWebCacheUpdate;
};

export type GWebCacheHttpResponse = GWebCacheResponse & {
  requestUrl: string;
  body: string;
  status: number;
  statusText: string;
  ok: boolean;
};

export type CacheAccessOptions = {
  state?: GWebCacheBootstrapState;
  now?: () => number;
  random?: () => number;
  persist?: () => Promise<void>;
};

export type BootstrapOptions = CacheAccessOptions & {
  caches?: readonly string[];
  client?: string;
  version?: string;
  network?: "gnutella" | "gnutella2";
  timeoutMs?: number;
  maxPeers?: number;
  maxCaches?: number;
  signal?: AbortSignal;
  /** Explicit transport override for tests; bypasses public-address checks. */
  fetchImpl?: FetchLike;
};

type BootstrapCacheError = {
  cache: string;
  message: string;
};

export type BootstrapResult = {
  peers: string[];
  caches: string[];
  queriedCaches: string[];
  successfulCaches: string[];
  errors: BootstrapCacheError[];
};

export type GWebCacheBootstrapState = {
  active?: boolean;
  nextAnnouncementAt?: number;
  aliveCaches?: string[];
  registry?: CacheState;
  requestActive?: boolean;
};

export type ConnectBootstrapOptions = BootstrapOptions & {
  peers: readonly string[];
  connectTimeoutMs: number;
  connectConcurrency: number;
  availableSlots: () => number;
  connectPeer: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<void>;
  addPeer?: (peer: string) => void;
  isSelfPeer?: (host: string, port: number) => boolean;
  canDialPeer?: (host: string, port: number) => boolean;
  maxBootstrapPeers?: number;
  maxBootstrapCaches?: number;
  state?: GWebCacheBootstrapState;
};

export type ConnectBootstrapResult = {
  attemptedPeers: string[];
  fetchedFromCaches: boolean;
  addedPeers: string[];
  queriedCaches: string[];
  errors: BootstrapResult["errors"];
};

export type ReportSelfOptions = CacheAccessOptions & {
  caches?: readonly string[];
  client?: string;
  version?: string;
  timeoutMs?: number;
  ip: string;
  cluster?: string;
  leafCount?: number;
  maxLeaves?: number;
  uptimeSec?: number;
  state?: GWebCacheBootstrapState;
  signal?: AbortSignal;
  /** Explicit transport override for tests; bypasses public-address checks. */
  fetchImpl?: FetchLike;
};

export type ReportSelfResult = {
  referenceCache?: string;
  attemptedCaches: string[];
  reportedCaches: string[];
  errors: BootstrapResult["errors"];
};

// Verified with nonempty Gnutella peer queries on 2026-09-27.
export const KNOWN_CACHES = [
  "http://cache.jayl.de/g2/gwc.php/",
  "http://gweb.4octets.co.uk/skulls.php",
  "http://gweb3.4octets.co.uk/gwc.php",
  "http://gweb4.4octets.co.uk/gwc.php",
  "http://midian.jayl.de/g2/bazooka.php",
  "http://midian.jayl.de/g2/gwc.php",
  "http://paper.gwc.dyslexicfish.net:3709/",
  "http://rock.gwc.dyslexicfish.net:3709/",
  "http://scissors.gwc.dyslexicfish.net:3709/",
  "http://skulls.gwc.dyslexicfish.net/skulls.php",
  "https://www.paper.gwc.dyslexicfish.net/",
  "https://www.rock.gwc.dyslexicfish.net/",
  "https://www.scissors.gwc.dyslexicfish.net/",
] as const;
