import { CANONICAL_HEADER_NAMES, MAX_HEADER_BYTES } from "../const";
import { normalizeIpv4, parsePeer } from "../discovery/addresses";
import type { PeerAddr } from "../types";

/** Find a token in a comma-separated header, ignoring case. */
export function hasToken(
  value: string | undefined,
  token: string,
): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .includes(token.toLowerCase());
}

/** Parse a true or false header value. */
export function parseBoolHeader(
  v: string | undefined,
): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

/** Parse a positive integer header value. */
export function parsePositiveIntHeader(
  v: string | undefined,
): number | undefined {
  if (!v) return undefined;
  const n = Number(v.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Normalize the first reported remote IPv4 address. */
export function parseRemoteIpHeader(
  v: string | undefined,
): string | undefined {
  if (!v) return undefined;
  return normalizeIpv4(v.split(",")[0]?.trim());
}

/** Parse valid endpoints from a comma-separated header. */
export function parsePeerHeaderList(v: string | undefined): PeerAddr[] {
  if (!v) return [];
  return v
    .split(",")
    .map((x) => parsePeer(x.trim()))
    .filter((x): x is PeerAddr => !!x);
}

/** Parse a peer's advertised listening endpoint. */
export function parseListenIpHeader(
  v: string | undefined,
): PeerAddr | undefined {
  if (!v) return undefined;
  return parsePeer(v.trim()) || undefined;
}

/** Copy headers with lowercase names. */
export function lowerCaseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Merge headers case-insensitively, preferring later values. */
export function mergeHeaders(
  ...parts: Array<Record<string, string> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) out[k.toLowerCase()] = v;
  }
  return out;
}

/** Find the byte offset after the header terminator. */
export function findHeaderEnd(raw: string): number {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return crlf + 4;
  if (lf !== -1) return lf + 2;
  return -1;
}

/** Bound a header without counting coalesced body or TLS bytes. */
export function boundedHeaderEnd(
  raw: string,
  protocol = "handshake",
): number {
  const cut = findHeaderEnd(raw.slice(0, MAX_HEADER_BYTES));
  if (cut === -1 && raw.length >= MAX_HEADER_BYTES) {
    throw new Error(`${protocol} headers too large`);
  }
  return cut;
}

function appendContinuationLine(
  headers: Record<string, string>,
  current: string,
  line: string,
): boolean {
  if (!/^[ \t]/.test(line) || !current) return false;
  headers[current] = `${headers[current]} ${line.trim()}`.trim();
  return true;
}

function recordHeaderLine(
  headers: Record<string, string>,
  line: string,
): string {
  const idx = line.indexOf(":");
  if (idx === -1) return "";
  const key = line.slice(0, idx).trim().toLowerCase();
  const value = line.slice(idx + 1).trim();
  headers[key] = headers[key] ? `${headers[key]},${value}` : value;
  return key;
}

/** Parse the start line and folded handshake headers. */
export function parseHandshakeBlock(raw: string): {
  startLine: string;
  headers: Record<string, string>;
} {
  const end = findHeaderEnd(raw);
  const text = end === -1 ? raw : raw.slice(0, end);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const startLine = lines.shift()?.trim() || "";
  const headers: Record<string, string> = {};
  let current = "";

  for (const line of lines) {
    if (!line) continue;
    if (appendContinuationLine(headers, current, line)) continue;
    current = recordHeaderLine(headers, line);
  }
  return { startLine, headers };
}

function canonicalHeaderName(key: string): string {
  return CANONICAL_HEADER_NAMES[key.toLowerCase()] || key;
}

/** Encode a handshake with canonical header names. */
export function buildHandshakeBlock(
  startLine: string,
  headers: Record<string, string>,
): Buffer {
  const lines = [startLine];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`${canonicalHeaderName(k)}: ${v}`);
  }
  lines.push("", "");
  return Buffer.from(lines.join("\r\n"), "latin1");
}

function summarizeHandshakeHeaders(
  headers: Record<string, string>,
): string {
  const parts = Object.entries(headers).map(
    ([key, value]) => `${canonicalHeaderName(key)}=${value}`,
  );
  return parts.length ? ` [${parts.join("; ")}]` : "";
}

/** Describe a handshake and every header for diagnostics. */
export function describeHandshakeResponse(
  startLine: string,
  headers: Record<string, string>,
): string {
  return `${startLine}${summarizeHandshakeHeaders(headers)}`;
}
