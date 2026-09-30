import crypto from "node:crypto";
import type { PongCacheEntry } from "./types";

/** Hash a pong payload for cache deduplication. */
export function pongCacheKey(payload: Buffer): string {
  return crypto.createHash("sha1").update(payload).digest("hex");
}

/** Select the oldest pong entries exceeding capacity. */
export function overflowPongCacheKeys(
  entries: Iterable<[string, Pick<PongCacheEntry, "at">]>,
  maxSize: number,
): string[] {
  const all = [...entries];
  if (all.length <= maxSize) return [];
  return all
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, all.length - maxSize)
    .map(([key]) => key);
}

/** Choose recent pongs within the remaining reply budget. */
export function selectCachedPongs(
  entries: Iterable<PongCacheEntry>,
  alreadySent: number,
  maxSent: number,
  exceptPeerKey: string,
  maxHops: number,
): PongCacheEntry[] {
  const available = Math.max(0, maxSent - alreadySent);
  if (available === 0) return [];
  return [...entries]
    .filter(
      (entry) =>
        entry.sourcePeerKey !== exceptPeerKey && entry.hops < maxHops,
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, available);
}
