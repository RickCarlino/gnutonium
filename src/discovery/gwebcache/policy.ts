import { isIP } from "node:net";
import { isRoutableIpv4 } from "../../shared";
import { describeHttpError, requestGWebCache } from "./response";
import { normalizeCacheUrl, rememberAliveCaches } from "./shared";
import type { CacheRecord, CacheState } from "./state";
import {
  CACHE_INTERVAL_SEC,
  createCacheState,
  MAX_CACHE_CANDIDATES,
  MAX_CACHE_RECORDS,
} from "./state";
import type {
  CacheAccessOptions,
  GWebCacheBootstrapState,
  GWebCacheHttpResponse,
  GWebCacheRequestOptions,
} from "./types";

type CacheOutcome = {
  cache?: string;
  result?: GWebCacheHttpResponse;
  error?: string;
  retryable?: boolean;
};

/** Referrals must name public HTTP endpoints, never credentials or local services. */
export function referralUrl(value: string): string | undefined {
  const key = normalizeCacheUrl(value);
  if (!key) return;
  const url = new URL(key);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return;
  if (["update", "ip", "url"].some((key) => url.searchParams.has(key)))
    return;
  if (isIP(host) && !isRoutableIpv4(host)) return;
  return key;
}

function networkDeclarations(result: GWebCacheHttpResponse): string[] {
  const networks = [...(result.pong?.networks ?? [])];
  for (const info of result.info) {
    if (info.key === "networks") networks.push(...info.values);
    if (info.key === "nets")
      networks.push(...info.values.flatMap((value) => value.split("-")));
  }
  return networks.map((value) => value.toLowerCase());
}

function validProtocolBody(result: GWebCacheHttpResponse): boolean {
  return (
    !!result.spec &&
    result.rawLines.length > 0 &&
    result.rawLines.every((line) => /^[a-z0-9]\|/i.test(line))
  );
}

function cacheResponseError(
  result: GWebCacheHttpResponse,
  network: string,
): string | undefined {
  const detail = (result.rawLines[0] || "empty body").slice(0, 160);
  if (isRateLimited(result)) return `cache rate limit: ${detail}`;
  if (!result.ok) return describeHttpError(result);
  if (!validProtocolBody(result))
    return `invalid spec2 gwebcache response: ${detail}`;
  if (result.info.some((line) => line.key === "net-not-supported"))
    return "unsupported network";
  const networks = networkDeclarations(result);
  if (networks.length && !networks.includes(network))
    return "unsupported network";
  return undefined;
}

function serverDelay(result: GWebCacheHttpResponse): number {
  let seconds = CACHE_INTERVAL_SEC;
  for (const line of result.rawLines) {
    const parts = line.toLowerCase().split("|");
    if (
      parts[0] !== "i" ||
      !["access", "update"].includes(parts[1]) ||
      parts[2] !== "period"
    )
      continue;
    const period = Number(parts[3]);
    if (Number.isSafeInteger(period) && period > seconds) seconds = period;
  }
  return seconds;
}

function nowSeconds(options: CacheAccessOptions): number {
  return Math.floor((options.now ?? Date.now)() / 1000);
}

function eligibleCaches(registry: CacheState, now: number) {
  return Object.entries(registry.entries).filter(
    ([, entry]) =>
      entry.status !== "rejected" && (entry.nextAllowedAt ?? 0) <= now,
  );
}

function chooseCache(
  registry: CacheState,
  now: number,
  random: () => number,
): [string, CacheRecord] | undefined {
  const eligible = eligibleCaches(registry, now);
  // Prefer untested entries to make discovery progress without separate probes.
  const candidates = eligible.filter(
    ([, entry]) => entry.status === "candidate",
  );
  const pool = candidates.length ? candidates : eligible;
  if (!pool.length) return;
  return pool[
    Math.min(pool.length - 1, Math.floor(random() * pool.length))
  ];
}

function isAnnouncement(request: GWebCacheRequestOptions): boolean {
  return request.ip !== undefined || request.mode === "update";
}

function blocked(
  session: GWebCacheBootstrapState,
  now: number,
  request: GWebCacheRequestOptions,
): boolean {
  return (
    !!session.requestActive ||
    !!request.signal?.aborted ||
    (isAnnouncement(request) && now < (session.nextAnnouncementAt ?? 0))
  );
}

async function checkedRequest(
  cache: string,
  request: GWebCacheRequestOptions,
): Promise<CacheOutcome> {
  try {
    const result = await requestGWebCache(cache, request);
    const error = cacheResponseError(
      result,
      request.network ?? "gnutella",
    );
    return error
      ? { cache, error, retryable: isRateLimited(result) }
      : { cache, result };
  } catch (cause) {
    // A programming exception is not evidence that a remote cache is broken.
    if (cause instanceof TypeError || cause instanceof ReferenceError)
      throw cause;
    return {
      cache,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function isRateLimited(result: GWebCacheHttpResponse): boolean {
  return (
    result.status === 429 ||
    result.rawLines.some((line) =>
      /^ERROR: Client returned too early$/i.test(line),
    )
  );
}

function acceptResponse(
  options: CacheAccessOptions,
  entry: CacheRecord,
  outcome: CacheOutcome,
  network: string,
): void {
  const { cache, result } = outcome;
  if (!cache || !result) return;
  const now = nowSeconds(options);
  entry.nextAllowedAt = now + serverDelay(result);
  if (!networkDeclarations(result).includes(network)) return;
  entry.status = "verified";
  entry.lastSuccessAt = now;
  delete entry.reason;
  rememberAliveCaches(options.state, [cache]);
  collectReferrals(options, result.caches, now);
}

function rejectResponse(
  session: GWebCacheBootstrapState,
  entry: CacheRecord,
  outcome: CacheOutcome,
  signal?: AbortSignal,
): void {
  if (!outcome.error || signal?.aborted) return;
  if (!outcome.retryable) entry.status = "rejected";
  entry.reason = outcome.error.slice(0, 256);
  session.aliveCaches = session.aliveCaches?.filter(
    (value) => value !== outcome.cache,
  );
}

async function reservedRequest(
  options: CacheAccessOptions,
  cache: string,
  entry: CacheRecord,
  request: GWebCacheRequestOptions,
): Promise<CacheOutcome> {
  // Persist before sending; restart must not bypass the reserved budget.
  await options.persist?.();
  const outcome = await checkedRequest(cache, request);
  rejectResponse(options.state!, entry, outcome, request.signal);
  acceptResponse(options, entry, outcome, request.network ?? "gnutella");
  await options.persist?.();
  return outcome;
}

/** Select one eligible cache; reads have per-cache cooldowns, announcements an hourly cadence. */
export async function accessCache(
  options: CacheAccessOptions & { caches?: readonly string[] },
  request: GWebCacheRequestOptions,
): Promise<CacheOutcome> {
  const session = (options.state ??= {});
  const registry = (session.registry ??= createCacheState(options.caches));
  const now = nowSeconds(options);
  if (blocked(session, now, request)) return {};
  const selection = chooseCache(
    registry,
    now,
    options.random ?? Math.random,
  );
  if (!selection) return {};
  const [cache, entry] = selection;
  session.requestActive = true;
  entry.lastAttemptAt = now;
  entry.nextAllowedAt = now + CACHE_INTERVAL_SEC;
  if (isAnnouncement(request))
    session.nextAnnouncementAt = now + CACHE_INTERVAL_SEC;
  try {
    return await reservedRequest(options, cache, entry, request);
  } finally {
    session.requestActive = false;
  }
}

/** A successful normal peer handshake supplies evidence missing from an old cache's pong. */
export async function confirmCacheHost(
  options: CacheAccessOptions,
  cache: string,
  referrals: string[],
): Promise<void> {
  const entry = options.state?.registry?.entries[cache];
  if (!entry || entry.status === "rejected") return;
  entry.status = "verified";
  entry.lastSuccessAt = nowSeconds(options);
  rememberAliveCaches(options.state, [cache]);
  collectReferrals(options, referrals, entry.lastSuccessAt);
  await options.persist?.();
}

function collectReferrals(
  options: CacheAccessOptions,
  referrals: string[],
  now: number,
): void {
  const registry = options.state?.registry;
  if (!registry) return;
  let candidatesLeft =
    MAX_CACHE_CANDIDATES -
    Object.values(registry.entries).filter(
      (row) => row.status === "candidate",
    ).length;
  for (const value of referrals) {
    if (
      candidatesLeft <= 0 ||
      Object.keys(registry.entries).length >= MAX_CACHE_RECORDS
    )
      break;
    const key = referralUrl(value);
    if (!key || registry.entries[key]) continue;
    registry.entries[key] = {
      status: "candidate",
      discoveredAt: now,
    };
    candidatesLeft--;
  }
}
