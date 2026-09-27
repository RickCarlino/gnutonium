import { expect, test } from "bun:test";
import {
  cacheResponseBody,
  fetchPublicCache,
  pinnedCacheLookup,
} from "../../../src/discovery/gwebcache/transport";
import {
  fetchBootstrapData,
  getMorePeers,
  requestGWebCache,
} from "../../../src/gwebcache_client";

test("public cache requests pin their resolved address and validate redirect destinations", async () => {
  const calls: string[] = [];
  const transport = {
    resolve: async (host: string) =>
      host === "cache.example" ? ["44.0.0.1"] : ["127.0.0.1"],
    request: async (url: URL, address: string) => {
      calls.push(`${url.hostname}:${address}`);
      return new Response(null, {
        status: 302,
        headers: { location: "http://internal.example/cache" },
      });
    },
  };
  await expect(
    fetchPublicCache("http://cache.example/", {}, 0, transport),
  ).rejects.toThrow("public IPv4");
  expect(calls).toEqual(["cache.example:44.0.0.1"]);
});

test("a mixed public/private DNS answer is rejected before making a request", async () => {
  let requests = 0;
  await expect(
    fetchPublicCache("http://cache.example/", {}, 0, {
      resolve: async () => ["44.0.0.1", "10.0.0.1"],
      request: async () => {
        requests++;
        return new Response("");
      },
    }),
  ).rejects.toThrow("public IPv4");
  expect(requests).toBe(0);
});

test("response size limits apply even when HTTP is successful", async () => {
  await expect(
    cacheResponseBody(new Response("x".repeat(256 * 1024 + 1))),
  ).rejects.toThrow("too large");
});

test("getMorePeers remains a peer-only public facade", async () => {
  expect(
    await getMorePeers({
      caches: ["http://cache.example/"],
      fetchImpl: async () =>
        new Response("I|pong|Cache|gnutella\nH|44.0.0.1:6346|0\n"),
    }),
  ).toEqual(["44.0.0.1:6346"]);
});

test("configured caches and direct cache requests reject local addresses by default", async () => {
  const cache = "http://127.0.0.1:1/cache";
  await expect(requestGWebCache(cache)).rejects.toThrow("public IPv4");
  const result = await fetchBootstrapData({ caches: [cache] });
  expect(result.peers).toEqual([]);
  expect(result.successfulCaches).toEqual([]);
  expect(result.errors).toEqual([
    { cache, message: "cache does not resolve to a public IPv4 address" },
  ]);
});

test("pinned DNS lookup honors single-address and all-address callback formats", () => {
  const lookup = pinnedCacheLookup("44.0.0.1");
  const results: unknown[][] = [];
  lookup("cache.example", { all: true }, (...args) => results.push(args));
  lookup("cache.example", { all: false }, (...args) => results.push(args));
  lookup("cache.example", {}, (...args) => results.push(args));
  expect(results).toEqual([
    [null, [{ address: "44.0.0.1", family: 4 }]],
    [null, "44.0.0.1", 4],
    [null, "44.0.0.1", 4],
  ]);
});
