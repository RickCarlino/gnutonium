import { DEFAULT_USER_AGENT } from "../../const";
import {
  DEFAULT_TIMEOUT_MS,
  normalizeCacheUrl,
  normalizeGWebCachePeer,
  normalizeNetwork,
  parseAge,
  parseNetworks,
  parseWarning,
  sanitizeClient,
  sanitizeVersion,
  splitBodyLines,
} from "./shared";
import { cacheResponseBody, fetchPublicCache } from "./transport";
import type {
  GWebCacheCacheEntry,
  GWebCacheHostEntry,
  GWebCacheHttpResponse,
  GWebCacheInfoLine,
  GWebCachePong,
  GWebCacheRequestOptions,
  GWebCacheResponse,
  GWebCacheUpdate,
} from "./types";

type GWebCacheResponseState = {
  peers: string[];
  caches: string[];
  warnings: string[];
  info: GWebCacheInfoLine[];
  hostEntries: GWebCacheHostEntry[];
  cacheEntries: GWebCacheCacheEntry[];
  seenPeers: Set<string>;
  seenCaches: Set<string>;
  pong?: GWebCachePong;
  update?: GWebCacheUpdate;
  recognized: boolean;
};

function buildUpdate(values: string[]): GWebCacheUpdate {
  const head = values[0]?.trim().toUpperCase() || "";
  if (head === "OK") {
    return { ok: true, warning: parseWarning(values.slice(1)), values };
  }
  if (head === "WARNING") {
    return {
      ok: false,
      warning: parseWarning(values.slice(1)) || "WARNING",
      values,
    };
  }
  return {
    ok: values.some((value) => value.trim().toUpperCase() === "OK"),
    warning: parseWarning(values),
    values,
  };
}

/** Summarize a failed GWebCache HTTP response. */
export function describeHttpError(result: GWebCacheHttpResponse): string {
  const summary =
    result.rawLines[0] || result.statusText || "request failed";
  return `HTTP ${result.status}: ${summary}`;
}

/** Describe why a GWebCache update was rejected. */
export function describeUpdateError(
  result: GWebCacheHttpResponse,
): string {
  if (!result.ok) return describeHttpError(result);
  if (!result.spec) return "unexpected non-spec2 gwebcache response";
  if (!result.update) return "missing spec2 gwebcache update response";
  return result.update.warning || "gwebcache update rejected";
}

function setGWebCacheFlag(
  url: URL,
  key: string,
  enabled: boolean | undefined,
): void {
  if (!enabled) return;
  url.searchParams.set(key, "1");
}

function applyRequestMode(
  url: URL,
  options: GWebCacheRequestOptions,
): void {
  url.searchParams.set("net", normalizeNetwork(options.network));
  if (options.mode === "update") {
    url.searchParams.set("update", "1");
    return;
  }
  url.searchParams.set("get", "1");
}

function applyRequestMetadata(
  url: URL,
  options: GWebCacheRequestOptions,
): void {
  if (options.spec) url.searchParams.set("spec", String(options.spec));
  if (options.ping !== false) url.searchParams.set("ping", "1");
  url.searchParams.set("client", sanitizeClient(options.client));
  url.searchParams.set("version", sanitizeVersion(options.version));
}

function applyPeerUpdate(url: URL, peerSpec: string | undefined): void {
  if (!peerSpec) return;
  const peer = normalizeGWebCachePeer(peerSpec);
  if (!peer) throw new Error(`invalid gwebcache peer update: ${peerSpec}`);
  url.searchParams.set("ip", peer);
  url.searchParams.set("update", "1");
}

function applyCacheUpdate(url: URL, cacheSpec: string | undefined): void {
  if (!cacheSpec) return;
  const cacheUrl = normalizeCacheUrl(cacheSpec);
  if (!cacheUrl)
    throw new Error(`invalid gwebcache cache update: ${cacheSpec}`);
  url.searchParams.set("url", cacheUrl);
  url.searchParams.set("update", "1");
}

function setOptionalCount(
  url: URL,
  key: string,
  value: number | undefined,
): void {
  if (!Number.isInteger(value) || (value || 0) < 0) return;
  url.searchParams.set(key, String(value));
}

function applyUpdateStats(
  url: URL,
  options: GWebCacheRequestOptions,
): void {
  setOptionalCount(url, "x_leaves", options.leafCount);
  setOptionalCount(url, "x_max", options.maxLeaves);
  setOptionalCount(url, "uptime", options.uptimeSec);
}

function applyLookupFlags(
  url: URL,
  options: GWebCacheRequestOptions,
): void {
  if (options.cluster?.trim()) {
    url.searchParams.set("cluster", options.cluster.trim());
  }
  setGWebCacheFlag(url, "getleaves", options.getLeaves);
  setGWebCacheFlag(url, "getclusters", options.getClusters);
  setGWebCacheFlag(url, "getvendors", options.getVendors);
  setGWebCacheFlag(url, "getuptime", options.getUptime);
}

/** Build a validated GWebCache request URL. */
export function buildGWebCacheUrl(
  baseUrl: string,
  options: GWebCacheRequestOptions = {},
): string {
  const normalizedBaseUrl = normalizeCacheUrl(baseUrl);
  if (!normalizedBaseUrl)
    throw new Error(`invalid gwebcache url: ${baseUrl}`);

  const url = new URL(normalizedBaseUrl);
  applyRequestMode(url, options);
  applyRequestMetadata(url, options);
  applyPeerUpdate(url, options.ip);
  applyCacheUpdate(url, options.url);
  applyUpdateStats(url, options);
  applyLookupFlags(url, options);
  return url.toString();
}

function createGWebCacheResponseState(): GWebCacheResponseState {
  return {
    peers: [],
    caches: [],
    warnings: [],
    info: [],
    hostEntries: [],
    cacheEntries: [],
    seenPeers: new Set<string>(),
    seenCaches: new Set<string>(),
    recognized: false,
  };
}

function addResponsePeer(
  state: GWebCacheResponseState,
  value: string,
  ageSec?: number,
  cluster?: string,
  leafCount?: number,
  vendor?: string,
  uptimeSec?: number,
  extraFields: string[] = [],
): void {
  const peer = normalizeGWebCachePeer(value);
  if (!peer || state.seenPeers.has(peer)) return;
  state.seenPeers.add(peer);
  state.peers.push(peer);
  state.hostEntries.push({
    peer,
    ageSec,
    cluster,
    leafCount,
    vendor,
    uptimeSec,
    extraFields,
  });
}

function addResponseCache(
  state: GWebCacheResponseState,
  value: string,
  ageSec?: number,
): void {
  const cacheUrl = normalizeCacheUrl(value);
  if (!cacheUrl || state.seenCaches.has(cacheUrl)) return;
  state.seenCaches.add(cacheUrl);
  state.caches.push(cacheUrl);
  state.cacheEntries.push({ url: cacheUrl, ageSec });
}

function applyPongInfo(
  state: GWebCacheResponseState,
  values: string[],
): void {
  state.pong = {
    name: values[0] || "",
    networks: parseNetworks(values[1]),
  };
}

function applyUpdateInfo(
  state: GWebCacheResponseState,
  values: string[],
): void {
  state.update = buildUpdate(values);
  if (state.update.warning) state.warnings.push(state.update.warning);
}

function applyWarningInfo(
  state: GWebCacheResponseState,
  values: string[],
): void {
  const warning = parseWarning(values);
  if (warning) state.warnings.push(warning);
}

function parseInfoLineIntoState(
  state: GWebCacheResponseState,
  parts: string[],
): void {
  const key = parts[1]?.trim().toLowerCase() || "";
  const values = parts.slice(2).map((value) => value.trim());
  if (key === "pong") return applyPongInfo(state, values);
  if (key === "update" && values[0]?.toLowerCase() !== "period")
    return applyUpdateInfo(state, values);
  if (key === "warning") return applyWarningInfo(state, values);
  if (key) state.info.push({ key, values });
}

function parseHostLineIntoState(
  state: GWebCacheResponseState,
  parts: string[],
): void {
  const values = parts.slice(1).map((value) => value.trim());
  addResponsePeer(
    state,
    values[0] || "",
    parseAge(values[1]),
    values[2] || undefined,
    parseAge(values[3]),
    values[4] || undefined,
    parseAge(values[5]),
    values.slice(6).filter(Boolean),
  );
}

function parseCacheLineIntoState(
  state: GWebCacheResponseState,
  parts: string[],
): void {
  const values = parts.slice(1).map((value) => value.trim());
  addResponseCache(state, values[0] || "", parseAge(values[1]));
}

function parseResponseLineIntoState(
  state: GWebCacheResponseState,
  line: string,
): void {
  const parts = line.split("|");
  const code = parts[0]?.trim().toUpperCase();
  if (code === "I") {
    state.recognized = true;
    parseInfoLineIntoState(state, parts);
    return;
  }
  if (code === "H") {
    state.recognized = true;
    parseHostLineIntoState(state, parts);
    return;
  }
  if (code === "U") {
    state.recognized = true;
    parseCacheLineIntoState(state, parts);
  }
}

/** Parse cache records, metadata, and warnings. */
export function parseGWebCacheResponse(body: string): GWebCacheResponse {
  const rawLines = splitBodyLines(body);
  const state = createGWebCacheResponseState();
  for (const line of rawLines) parseResponseLineIntoState(state, line);

  return {
    spec: state.recognized ? 2 : undefined,
    rawLines,
    peers: state.peers,
    caches: state.caches,
    warnings: [...new Set(state.warnings)],
    info: state.info,
    hostEntries: state.hostEntries,
    cacheEntries: state.cacheEntries,
    pong: state.pong,
    update: state.update,
  };
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  if (!signal && !(timeoutMs > 0)) return { cleanup: () => void 0 };

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort(signal?.reason);

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      controller.abort(
        new Error(`gwebcache request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Fetch and parse a cache response with cancellation. */
export async function requestGWebCache(
  baseUrl: string,
  options: GWebCacheRequestOptions = {},
): Promise<GWebCacheHttpResponse> {
  const requestUrl = buildGWebCacheUrl(baseUrl, options);
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl || fetchPublicCache;
  const { signal, cleanup } = combineSignals(options.signal, timeoutMs);

  try {
    const response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: {
        Accept: "text/plain, text/*;q=0.9, */*;q=0.1",
        "Cache-Control": "no-cache",
        "User-Agent": DEFAULT_USER_AGENT,
      },
      signal,
    });
    const body = await cacheResponseBody(response);
    return {
      requestUrl,
      body,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      ...parseGWebCacheResponse(body),
    };
  } finally {
    cleanup();
  }
}
