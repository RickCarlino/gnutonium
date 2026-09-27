import { DEFAULT_USER_AGENT, DEFAULT_VENDOR_CODE } from "../../const";
import {
  isRoutableIpv4,
  normalizePeer,
  parsePeer,
  unique,
} from "../../shared";
import { KNOWN_CACHES, type GWebCacheBootstrapState } from "./types";

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_PEERS = 20;
export const DEFAULT_MAX_CACHES = 20;
export const DEFAULT_MAX_BOOTSTRAP_CACHES = 256;

/** Normalize an HTTP cache URL without its fragment. */
export function normalizeCacheUrl(value: string): string | undefined {
  const trimmed = String(value || "").trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return undefined;
    if (url.username || url.password) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeCacheList(caches: readonly string[] = []): string[] {
  return unique(
    [...caches]
      .map((cache) => normalizeCacheUrl(cache))
      .filter((cache): cache is string => !!cache),
  );
}

/** Normalize supplied caches or use the built-in seeds. */
export function seedCacheList(caches?: readonly string[]): string[] {
  return normalizeCacheList(caches?.length ? [...caches] : KNOWN_CACHES);
}

/** Read normalized cache URLs from bootstrap state. */
export function aliveCachesForState(
  state: GWebCacheBootstrapState | undefined,
): string[] {
  return normalizeCacheList(state?.aliveCaches);
}

/** Merge responding caches into bootstrap state. */
export function rememberAliveCaches(
  state: GWebCacheBootstrapState | undefined,
  caches: readonly string[],
): void {
  if (!state) return;
  state.aliveCaches = normalizeCacheList([
    ...aliveCachesForState(state),
    ...caches,
  ]);
}

/** Normalize the four-character client vendor code. */
export function sanitizeClient(value: string | undefined): string {
  const client = String(value || DEFAULT_VENDOR_CODE)
    .trim()
    .toUpperCase();
  return client.slice(0, 4) || DEFAULT_VENDOR_CODE;
}

/** Normalize the client version or use its default. */
export function sanitizeVersion(value: string | undefined): string {
  const version = String(value || DEFAULT_USER_AGENT).trim();
  return version || DEFAULT_USER_AGENT;
}

/** Normalize a supported GWebCache network name. */
export function normalizeNetwork(
  value: string | undefined,
): "gnutella" | "gnutella2" {
  const network = String(value || "gnutella")
    .trim()
    .toLowerCase();
  if (network === "gnutella" || network === "gnutella2") return network;
  throw new Error(`unsupported gwebcache network: ${value}`);
}

/** Validate and normalize a publicly routable endpoint. */
export function normalizeGWebCachePeer(value: string): string | undefined {
  const parsed = parsePeer(value);
  if (!parsed) return undefined;
  if (!isRoutableIpv4(parsed.host)) return undefined;
  return normalizePeer(parsed.host, parsed.port);
}

/** Parse a nonnegative integer age. */
export function parseAge(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const age = Number(value);
  return Number.isInteger(age) && age >= 0 ? age : undefined;
}

/** Join warning fields into an optional message. */
export function parseWarning(values: string[]): string | undefined {
  const warning = values.join("|").trim();
  return warning || undefined;
}

/** Split and deduplicate advertised network names. */
export function parseNetworks(value: string | undefined): string[] {
  if (!value) return [];
  return unique(
    value
      .split("-")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

/** Strip the BOM and return trimmed nonempty lines. */
export function splitBodyLines(body: string): string[] {
  return body
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
