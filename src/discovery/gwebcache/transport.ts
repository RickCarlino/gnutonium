import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { isRoutableIpv4 } from "../../shared";

const MAX_BODY_BYTES = 256 * 1024;

/** Bound cache responses; an HTML error page must not consume unlimited memory. */
export async function cacheResponseBody(
  response: Response,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BODY_BYTES)
        throw new Error("gwebcache response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

type PublicCacheTransport = {
  resolve: (host: string) => Promise<string[]>;
  request: (
    url: URL,
    address: string,
    init: RequestInit,
  ) => Promise<Response>;
};

const publicTransport: PublicCacheTransport = {
  resolve: async (host) =>
    (await lookup(host, { family: 4, all: true })).map(
      ({ address }) => address,
    ),
  request: requestPinnedCache,
};

/** Pin public DNS results for all cache URLs, including every redirect hop. */
export async function fetchPublicCache(
  input: string,
  init: RequestInit,
  redirects = 0,
  transport: PublicCacheTransport = publicTransport,
): Promise<Response> {
  const url = new URL(input);
  validatePublicUrl(url);
  init.signal?.throwIfAborted();
  const address = await resolvePublicAddress(url, transport);
  init.signal?.throwIfAborted();
  const response = await transport.request(url, address, init);
  if (![301, 302, 303, 307, 308].includes(response.status))
    return response;
  const location = response.headers.get("location");
  if (!location || redirects >= 3)
    throw new Error("invalid gwebcache redirect");
  return fetchPublicCache(
    new URL(location, url).toString(),
    init,
    redirects + 1,
    transport,
  );
}

function validatePublicUrl(url: URL): void {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("invalid cache URL");
}

async function resolvePublicAddress(
  url: URL,
  transport: PublicCacheTransport,
): Promise<string> {
  const addresses = await transport.resolve(url.hostname);
  if (
    !addresses.length ||
    addresses.some((address) => !isRoutableIpv4(address))
  )
    throw new Error("cache does not resolve to a public IPv4 address");
  return addresses[0];
}

/** Request a previously validated address while preserving the URL hostname. */
export function requestPinnedCache(
  url: URL,
  address: string,
  init: RequestInit,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? https.request : http.request;
    const req = send(
      url,
      {
        method: "GET",
        headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal ?? undefined,
        family: 4,
        lookup: pinnedCacheLookup(address),
      },
      (res) => readNodeResponse(res, resolve, reject),
    );
    req.on("error", reject);
    req.end();
  });
}

function readNodeResponse(
  res: http.IncomingMessage,
  resolve: (response: Response) => void,
  reject: (error: Error) => void,
): void {
  const chunks: Buffer[] = [];
  let length = 0;
  res.on("data", (chunk: Buffer) => {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      res.destroy(new Error("gwebcache response too large"));
      return;
    }
    chunks.push(chunk);
  });
  res.on("error", reject);
  res.on("end", () => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (value !== undefined)
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const status = res.statusCode ?? 502;
    resolve(
      new Response(
        [204, 205, 304].includes(status) ? null : Buffer.concat(chunks),
        { status, headers },
      ),
    );
  });
}

/** Honor both Node lookup callback forms without resolving the hostname again. */
export function pinnedCacheLookup(address: string): LookupFunction {
  return (_host, options, callback) => {
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}
