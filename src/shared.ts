import fsp from "node:fs/promises";
import path from "node:path";

export {
  ipv4Subnet16,
  isRoutableIpv4,
  isUnspecifiedIpv4,
  normalizeIpv4,
  normalizePeer,
  parsePeer,
} from "./discovery/addresses";

/** Return the current time as an ISO timestamp. */
export function ts(): string {
  return new Date().toISOString();
}

/** Extract a message from an unknown error value. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convert Latin-1 strings to bytes, preserving buffers. */
export function toBuffer(chunk: string | Buffer): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
}

/** Wait for the requested number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Remove duplicates while preserving encounter order. */
export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Check whether a path is accessible. */
export async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Create a directory and any missing parents. */
export async function ensureDir(p: string): Promise<void> {
  try {
    await fsp.mkdir(p, { recursive: true });
  } catch (e) {
    // Bun's compiled Windows runtime can report EEXIST for an already-existing
    // directory on first-run config creation.
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isDirectory()) throw e;
  }
}

async function* walkFilesRecursive(
  dir: string,
): AsyncGenerator<string, void, void> {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  ents.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of ents) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFilesRecursive(abs);
    else if (ent.isFile()) yield abs;
  }
}

/** Yield file paths recursively beneath a directory. */
export async function* walkFilesIter(
  root: string,
): AsyncGenerator<string, void, void> {
  if (!(await fileExists(root))) return;
  yield* walkFilesRecursive(root);
}

/** Encode an IPv4 address in network byte order. */
export function ipToBytesBE(ip: string): Buffer {
  const parts = ip.split(".").map((x) => Number(x));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return Buffer.from(parts);
}

/** Encode an IPv4 address in little-endian order. */
export function ipToBytesLE(ip: string): Buffer {
  return Buffer.from([...ipToBytesBE(ip)].reverse());
}

/** Decode four network-order bytes as IPv4. */
export function bytesToIpBE(buf: Buffer): string {
  if (buf.length !== 4)
    throw new Error(`expected 4 bytes for IPv4, got ${buf.length}`);
  return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

/** Decode four little-endian bytes as IPv4. */
export function bytesToIpLE(buf: Buffer): string {
  if (buf.length !== 4)
    throw new Error(`expected 4 bytes for IPv4, got ${buf.length}`);
  return `${buf[3]}.${buf[2]}.${buf[1]}.${buf[0]}`;
}

/** Make a peer filename a single portable filesystem component. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"|?*\\/\x00-\x1f\x7f-\x9f]/g, "_")
    .replace(/[. ]+$/, "");
  if (!cleaned) return "_";
  // Windows treats these as devices even with an extension or spaces.
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(
    cleaned,
  )
    ? `_${cleaned}`
    : cleaned;
}
