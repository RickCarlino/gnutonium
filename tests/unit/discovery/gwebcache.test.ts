import { describe, expect, test } from "bun:test";
import {
  describeHttpError,
  describeUpdateError,
} from "../../../src/discovery/gwebcache/response";
import {
  buildGWebCacheUrl,
  KNOWN_CACHES,
  parseGWebCacheResponse,
  requestGWebCache,
} from "../../../src/gwebcache_client";

describe("gwebcache client", () => {
  test("builds spec2 request URLs with update parameters", () => {
    const built = new URL(
      buildGWebCacheUrl(KNOWN_CACHES[0], {
        mode: "get",
        network: "gnutella",
        client: "nium",
        version: "0.6-test",
        ip: "66.132.55.12:6346",
        url: "https://cache.example.net/gcache.php",
        cluster: "up",
        leafCount: 45,
        maxLeaves: 50,
        uptimeSec: 7200,
        getLeaves: true,
        getClusters: true,
        getVendors: true,
        getUptime: true,
        spec: 2,
      }),
    );

    expect(built.searchParams.get("get")).toBe("1");
    expect(built.searchParams.get("net")).toBe("gnutella");
    expect(built.searchParams.get("client")).toBe("NIUM");
    expect(built.searchParams.get("version")).toBe("0.6-test");
    expect(built.searchParams.get("ping")).toBe("1");
    expect(built.searchParams.get("update")).toBe("1");
    expect(built.searchParams.get("ip")).toBe("66.132.55.12:6346");
    expect(built.searchParams.get("url")).toBe(
      "https://cache.example.net/gcache.php",
    );
    expect(built.searchParams.get("cluster")).toBe("up");
    expect(built.searchParams.get("x_leaves")).toBe("45");
    expect(built.searchParams.get("x_max")).toBe("50");
    expect(built.searchParams.get("uptime")).toBe("7200");
    expect(built.searchParams.get("getleaves")).toBe("1");
    expect(built.searchParams.get("getclusters")).toBe("1");
    expect(built.searchParams.get("getvendors")).toBe("1");
    expect(built.searchParams.get("getuptime")).toBe("1");
    expect(built.searchParams.get("spec")).toBe("2");
  });

  test("ignores legacy or malformed response lines", () => {
    const result = parseGWebCacheResponse(`
      PONG ExampleCache 1.0
      66.132.55.12:6346
      WARNING: legacy cache
    `);

    expect(result.spec).toBeUndefined();
    expect(result.pong).toBeUndefined();
    expect(result.peers).toEqual([]);
    expect(result.caches).toEqual([]);
  });

  test("parses spec2 responses, warnings, and extended host fields", () => {
    const result = parseGWebCacheResponse(`
      I|pong|ExampleCache 2.0|gnutella-gnutella2
      I|update|OK|Already present
      I|WARNING|You came back too early
      H|66.132.55.12:6346|3600|core|45|LIME/5.5|7200|stable
      H|10.0.0.1:6346|120
      U|http://cache1.example.net/gcache.php|7200
    `);

    expect(result.spec).toBe(2);
    expect(result.pong).toEqual({
      name: "ExampleCache 2.0",
      networks: ["gnutella", "gnutella2"],
    });
    expect(result.update).toEqual({
      ok: true,
      warning: "Already present",
      values: ["OK", "Already present"],
    });
    expect(result.warnings).toEqual([
      "Already present",
      "You came back too early",
    ]);
    expect(result.peers).toEqual(["66.132.55.12:6346"]);
    expect(result.hostEntries).toEqual([
      {
        peer: "66.132.55.12:6346",
        ageSec: 3600,
        cluster: "core",
        leafCount: 45,
        vendor: "LIME/5.5",
        uptimeSec: 7200,
        extraFields: ["stable"],
      },
    ]);
    expect(result.caches).toEqual([
      "http://cache1.example.net/gcache.php",
    ]);
  });

  test("describes update errors and fallback update warnings", () => {
    const warningResult = parseGWebCacheResponse(`
      I|pong|ExampleCache 2.0|gnutella
      I|update|WARNING|Slow down
    `);
    expect(warningResult.update).toEqual({
      ok: false,
      warning: "Slow down",
      values: ["WARNING", "Slow down"],
    });

    const fallbackResult = parseGWebCacheResponse(`
      I|pong|ExampleCache 2.0|gnutella
      I|update|queued|OK|WARNING: Try later
    `);
    expect(fallbackResult.update).toEqual({
      ok: true,
      warning: "queued|OK|WARNING: Try later",
      values: ["queued", "OK", "WARNING: Try later"],
    });

    expect(
      describeHttpError({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        rawLines: ["Required network not accepted"],
      } as never),
    ).toBe("HTTP 503: Required network not accepted");
    expect(
      describeUpdateError({
        ok: true,
        status: 200,
        statusText: "OK",
        rawLines: [],
        spec: 2,
        update: warningResult.update,
      } as never),
    ).toBe("Slow down");
    expect(
      describeUpdateError({
        ok: true,
        status: 200,
        statusText: "OK",
        rawLines: [],
        spec: 2,
        update: fallbackResult.update,
      } as never),
    ).toBe("queued|OK|WARNING: Try later");
    expect(
      describeUpdateError({
        ok: true,
        status: 200,
        statusText: "OK",
        rawLines: [],
      } as never),
    ).toBe("unexpected non-spec2 gwebcache response");
    expect(
      describeUpdateError({
        ok: true,
        status: 200,
        statusText: "OK",
        rawLines: [],
        spec: 2,
      } as never),
    ).toBe("missing spec2 gwebcache update response");
  });

  test("fetches and parses a gwebcache response", async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(
        "I|pong|ExampleCache 2.0|gnutella\nH|66.132.55.12:6346|5\n",
        { status: 200, statusText: "OK" },
      );
    };

    const result = await requestGWebCache("http://cache.example/gwc.php", {
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(seen).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.peers).toEqual(["66.132.55.12:6346"]);
    expect(new URL(seen[0]).searchParams.get("get")).toBe("1");
  });

  test("propagates external aborts and request timeouts", async () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error("stopped"));
    await expect(
      requestGWebCache("http://cache.example/gwc.php", {
        signal: preAborted.signal,
        timeoutMs: 0,
        fetchImpl: async (_input, init) => {
          const signal = init?.signal as AbortSignal;
          expect(signal.aborted).toBe(true);
          throw signal.reason;
        },
      }),
    ).rejects.toThrow("stopped");

    const externalAbort = new AbortController();
    await expect(
      requestGWebCache("http://cache.example/gwc.php", {
        signal: externalAbort.signal,
        timeoutMs: 0,
        fetchImpl: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            queueMicrotask(() =>
              externalAbort.abort(new Error("cancelled")),
            );
          }),
      }),
    ).rejects.toThrow("cancelled");

    await expect(
      requestGWebCache("http://cache.example/gwc.php", {
        timeoutMs: 1,
        fetchImpl: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      }),
    ).rejects.toThrow("gwebcache request timed out after 1ms");
  });
});
