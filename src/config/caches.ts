import {
  createCacheState,
  isRecoverableCacheRejection,
  readCacheState,
  type CacheState,
} from "../discovery/gwebcache/state";
import type { PersistedDoc } from "./types";

/** Merge the former seed list and history once; current objects are authoritative. */
export function loadCacheConfig(doc: PersistedDoc): CacheState {
  const config = doc.config ?? {};
  const state = doc.state ?? {};
  const current = config.gwebcaches;
  const cache = readCacheState(current ?? state.gwebcaches);
  if (current == null) mergeLegacySeeds(cache, config.gwebcache_urls);
  if (!Object.keys(cache.entries).length)
    cache.entries = createCacheState().entries;
  return cache;
}

function mergeLegacySeeds(cache: CacheState, value: unknown): void {
  const urls = Array.isArray(value)
    ? value.filter((url): url is string => typeof url === "string")
    : [];
  // With history but no seeds, keep the remembered collection as-is.
  if (!urls.length && Object.keys(cache.entries).length) return;
  const seeds = createCacheState(urls);
  for (const [url, record] of Object.entries(seeds.entries)) {
    cache.entries[url] = {
      ...record,
      ...cache.entries[url],
    };
  }
  cache.entries = readCacheState(cache.entries).entries;
}

/** Rewrite legacy layouts and seed an empty collection on load. */
export function needsCacheMigration(doc: PersistedDoc): boolean {
  const config = doc.config ?? {};
  const state = doc.state ?? {};
  const entries = config.gwebcaches;
  return (
    entries == null ||
    typeof entries !== "object" ||
    !Object.keys(entries).length ||
    config.gwebcache_urls !== undefined ||
    state.gwebcaches !== undefined ||
    state.gwebcache_next_request_at !== undefined ||
    Object.values(entries).some(needsCacheRecordMigration)
  );
}

/** Normalize persisted records or initialize defaults for a new document. */
export function runtimeCacheConfig(value?: CacheState): CacheState {
  return value ? readCacheState(value.entries) : createCacheState();
}

function needsCacheRecordMigration(value: unknown): boolean {
  return (
    (value !== null && typeof value === "object" && "source" in value) ||
    isRecoverableCacheRejection(value)
  );
}
