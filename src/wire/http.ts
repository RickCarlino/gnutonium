import { boundedHeaderEnd } from "./handshake";

/** Bound headers without counting an already-arrived response body. */
export function boundedHttpHeaderEnd(raw: string): number {
  return boundedHeaderEnd(raw, "HTTP");
}

/** Parse HTTP headers with lowercase field names. */
export function parseHttpHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line
      .slice(idx + 1)
      .trim();
  }
  return out;
}
