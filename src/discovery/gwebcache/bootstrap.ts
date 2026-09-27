import { addPeerCandidatesToKnownSet, normalizePeerCandidates } from "..";
import { accessCache, confirmCacheHost } from "./policy";
import { describeUpdateError } from "./response";
import {
  aliveCachesForState,
  DEFAULT_MAX_BOOTSTRAP_CACHES,
  DEFAULT_MAX_CACHES,
  DEFAULT_MAX_PEERS,
  normalizeGWebCachePeer,
} from "./shared";
import type {
  BootstrapOptions,
  BootstrapResult,
  ConnectBootstrapOptions,
  ConnectBootstrapResult,
  GWebCacheHttpResponse,
  GWebCacheRequestOptions,
  ReportSelfOptions,
  ReportSelfResult,
} from "./types";

function emptyConnectBootstrapResult(
  attemptedPeers: string[],
): ConnectBootstrapResult {
  return {
    attemptedPeers,
    fetchedFromCaches: false,
    addedPeers: [],
    queriedCaches: [],
    errors: [],
  };
}

function buildBootstrapFetchOptions(
  options: ConnectBootstrapOptions,
): BootstrapOptions {
  return {
    caches: options.caches,
    client: options.client,
    version: options.version,
    network: options.network,
    timeoutMs: options.timeoutMs,
    maxPeers: options.maxBootstrapPeers || DEFAULT_MAX_PEERS,
    maxCaches: options.maxBootstrapCaches || DEFAULT_MAX_BOOTSTRAP_CACHES,
    state: options.state,
    now: options.now,
    random: options.random,
    persist: options.persist,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  };
}

function addDiscoveredBootstrapPeers(
  peers: ReturnType<typeof normalizePeerCandidates>,
  knownPeers: Set<string>,
  addPeer: ConnectBootstrapOptions["addPeer"],
): string[] {
  const addedPeers = addPeerCandidatesToKnownSet(peers, knownPeers);
  for (const peer of addedPeers) {
    addPeer?.(peer);
  }
  return addedPeers;
}

async function fetchAndRetryBootstrapPeers(
  knownPeers: Set<string>,
  options: ConnectBootstrapOptions,
): Promise<{
  retryAttempt: Awaited<ReturnType<typeof connectBootstrapPeerSet>>;
  addedPeers: string[];
  queriedCaches: string[];
  errors: BootstrapResult["errors"];
}> {
  const bootstrap = await fetchBootstrapData(
    buildBootstrapFetchOptions(options),
  );

  const discovered = dialCandidates(bootstrap.peers, options).filter(
    (peer) => !knownPeers.has(peer.peer),
  );
  const addedPeers = addDiscoveredBootstrapPeers(
    discovered,
    knownPeers,
    options.addPeer,
  );
  const retryAttempt = await connectBootstrapPeerSet(discovered, options);
  if (retryAttempt.successCount && bootstrap.queriedCaches[0])
    await confirmCacheHost(
      options,
      bootstrap.queriedCaches[0],
      bootstrap.caches,
    );
  return {
    retryAttempt,
    addedPeers,
    queriedCaches: bootstrap.queriedCaches,
    errors: bootstrap.errors,
  };
}

async function connectBootstrapPeerSet(
  peers: ReturnType<typeof normalizePeerCandidates>,
  options: Pick<
    ConnectBootstrapOptions,
    | "availableSlots"
    | "connectConcurrency"
    | "connectPeer"
    | "connectTimeoutMs"
    | "signal"
    | "canDialPeer"
  >,
): Promise<{
  attemptedPeers: string[];
  successCount: number;
}> {
  const availableSlots = Math.max(0, options.availableSlots());
  const workerCount = Math.min(
    Math.max(1, options.connectConcurrency),
    availableSlots,
    peers.length,
  );
  if (!workerCount) return { attemptedPeers: [], successCount: 0 };

  const attemptedPeers: string[] = [];
  let successCount = 0;
  let next = 0;

  const dialNext = async (): Promise<void> => {
    while (next < peers.length) {
      if (options.availableSlots() <= 0 || options.signal?.aborted) return;
      const peer = peers[next++];
      if (
        options.canDialPeer &&
        !options.canDialPeer(peer.host, peer.port)
      )
        continue;
      attemptedPeers.push(peer.peer);
      try {
        await options.connectPeer(
          peer.host,
          peer.port,
          options.connectTimeoutMs,
        );
        successCount += 1;
      } catch {
        // Keep walking until the bootstrap list is exhausted.
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => dialNext()));
  return { attemptedPeers, successCount };
}

function mergeBootstrapResponse(
  result: BootstrapResult | GWebCacheHttpResponse,
  peers: Set<string>,
  caches: Set<string>,
  maxPeers: number,
  maxCaches: number,
): void {
  for (const peer of result.peers) {
    if (peers.size >= maxPeers) break;
    peers.add(peer);
  }
  for (const cache of result.caches) {
    if (caches.size >= maxCaches) break;
    caches.add(cache);
  }
}

function buildBootstrapRequestOptions(
  options: BootstrapOptions,
): GWebCacheRequestOptions {
  return {
    mode: "get",
    spec: 2,
    network: options.network || "gnutella",
    client: options.client,
    version: options.version,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  };
}

/** Collect peer and cache addresses from seed caches. */
export async function fetchBootstrapData(
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const peers = new Set<string>();
  const caches = new Set<string>();
  const outcome = await accessCache(
    options,
    buildBootstrapRequestOptions(options),
  );
  if (outcome.result)
    mergeBootstrapResponse(
      outcome.result,
      peers,
      caches,
      Math.max(1, options.maxPeers ?? DEFAULT_MAX_PEERS),
      Math.max(1, options.maxCaches ?? DEFAULT_MAX_CACHES),
    );
  return {
    peers: [...peers],
    caches: [...caches],
    queriedCaches: outcome.cache ? [outcome.cache] : [],
    successfulCaches: verifiedResponseCaches(options, outcome.cache),
    errors:
      outcome.cache && outcome.error
        ? [{ cache: outcome.cache, message: outcome.error }]
        : [],
  };
}

/** Fetch bootstrap peer endpoints. */
export async function getMorePeers(
  options: BootstrapOptions = {},
): Promise<string[]> {
  const result = await fetchBootstrapData(options);
  return result.peers;
}

/** Report the local public endpoint to seed caches. */
export async function reportSelfToGWebCaches(
  options: ReportSelfOptions,
): Promise<ReportSelfResult> {
  const peer = normalizeGWebCachePeer(options.ip);
  if (!peer)
    throw new Error(`invalid gwebcache peer update: ${options.ip}`);

  const referenceCache = aliveCachesForState(options.state)[0];
  const outcome = await accessCache(options, {
    mode: "get",
    network: "gnutella",
    spec: 2,
    client: options.client,
    version: options.version,
    ip: peer,
    // Never advertise a seed or referral that has not worked this session.
    url: referenceCache,
    cluster: options.cluster,
    leafCount: options.leafCount,
    maxLeaves: options.maxLeaves,
    uptimeSec: options.uptimeSec,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
  const error = reportError(outcome.error, outcome.result);
  return {
    referenceCache,
    attemptedCaches: outcome.cache ? [outcome.cache] : [],
    reportedCaches:
      outcome.cache && outcome.result?.update?.ok ? [outcome.cache] : [],
    errors:
      outcome.cache && error
        ? [{ cache: outcome.cache, message: error }]
        : [],
  };
}

function dialCandidates(
  peers: readonly string[],
  options: ConnectBootstrapOptions,
) {
  return normalizePeerCandidates(peers, options.isSelfPeer)
    .filter(
      (peer) =>
        !options.canDialPeer || options.canDialPeer(peer.host, peer.port),
    )
    .slice(0, options.maxBootstrapPeers ?? DEFAULT_MAX_PEERS);
}

function hasCapacity(options: ConnectBootstrapOptions): boolean {
  return !options.signal?.aborted && options.availableSlots() > 0;
}

/** One discovery tick: try dialable peers, then at most one eligible cache. */
export async function connectBootstrapPeers(
  options: ConnectBootstrapOptions,
): Promise<ConnectBootstrapResult> {
  const session = (options.state ??= {});
  const result = emptyConnectBootstrapResult([]);
  if (session.active || !hasCapacity(options)) return result;
  session.active = true;
  try {
    const candidates = dialCandidates(options.peers, options);
    const initial = await connectBootstrapPeerSet(candidates, options);
    result.attemptedPeers.push(...initial.attemptedPeers);
    if (initial.successCount || !hasCapacity(options)) return result;
    const retry = await fetchAndRetryBootstrapPeers(
      new Set(initial.attemptedPeers),
      options,
    );
    result.attemptedPeers.push(...retry.retryAttempt.attemptedPeers);
    result.addedPeers = retry.addedPeers;
    result.queriedCaches = retry.queriedCaches;
    result.errors = retry.errors;
    result.fetchedFromCaches = retry.queriedCaches.length > 0;
    return result;
  } finally {
    session.active = false;
  }
}

function verifiedResponseCaches(
  options: BootstrapOptions,
  cache?: string,
): string[] {
  if (!cache || !options.state?.aliveCaches?.includes(cache)) return [];
  return [cache];
}

function reportError(
  error?: string,
  result?: GWebCacheHttpResponse,
): string | undefined {
  if (error) return error;
  if (result && !result.update?.ok) return describeUpdateError(result);
  return undefined;
}
