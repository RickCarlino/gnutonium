import { normalizeCacheUrl, seedCacheList } from "./shared";

export const CACHE_INTERVAL_SEC = 60 * 60;
export const MAX_CACHE_RECORDS = 200;
export const MAX_CACHE_CANDIDATES = 50;

export type CacheRecord = {
  status: "candidate" | "verified" | "rejected";
  discoveredAt: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  nextAllowedAt?: number;
  reason?: string;
};

export type CacheState = {
  entries: Record<string, CacheRecord>;
};

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

/** Read bounded cache history without restoring session verification. */
export function readCacheState(entries: unknown): CacheState {
  const state: CacheState = {
    entries: {},
  };
  if (!entries || typeof entries !== "object" || Array.isArray(entries))
    return state;
  for (const [url, value] of Object.entries(entries).slice(
    0,
    MAX_CACHE_RECORDS,
  )) {
    const key = normalizeCacheUrl(url);
    const record = readCacheRecord(value);
    if (key && record) state.entries[key] = record;
  }
  return state;
}

function readCacheRecord(value: unknown): CacheRecord | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (!["candidate", "verified", "rejected"].includes(String(row.status)))
    return;
  const reset = isRecoverableCacheRejection(row);
  return {
    status: reset ? "candidate" : (row.status as CacheRecord["status"]),
    discoveredAt: timestamp(row.discoveredAt) ?? 0,
    lastAttemptAt: timestamp(row.lastAttemptAt),
    lastSuccessAt: timestamp(row.lastSuccessAt),
    nextAllowedAt: timestamp(row.nextAllowedAt),
    reason:
      !reset && typeof row.reason === "string"
        ? row.reason.slice(0, 256)
        : undefined,
  };
}

/** Build cache objects from supplied URLs, or bundled defaults when empty. */
export function createCacheState(caches?: readonly string[]): CacheState {
  return {
    entries: Object.fromEntries(
      seedCacheList(caches).map((url) => [
        url,
        {
          status: "candidate",
          discoveredAt: 0,
        },
      ]),
    ),
  };
}

/** Retry old ambiguous responses once, and recover from our former DNS callback bug. */
export function isRecoverableCacheRejection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    row.status === "rejected" &&
    typeof row.reason === "string" &&
    (row.reason === "invalid spec2 gwebcache response" ||
      (row.reason.startsWith("results.sort is not a function") &&
        row.reason.includes("b.family - a.family")))
  );
}
