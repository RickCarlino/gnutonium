import { expect, test } from "bun:test";
import { referralUrl } from "../../../src/discovery/gwebcache/policy";
import type {
  BootstrapOptions,
  ConnectBootstrapOptions,
  GWebCacheBootstrapState,
} from "../../../src/discovery/gwebcache/types";
import {
  connectBootstrapPeers,
  fetchBootstrapData,
  reportSelfToGWebCaches,
} from "../../../src/gwebcache_client";

const first = "http://first.example/cache";
const second = "http://second.example/cache";
const hour = 3_600_000;

function fixture() {
  let time = 1_700_000_000_000;
  const state: GWebCacheBootstrapState = {};
  const calls: URL[] = [];
  const options: BootstrapOptions = {
    state,
    caches: [first],
    now: () => time,
    random: () => 0,
    fetchImpl: async (url) => {
      calls.push(new URL(String(url)));
      return new Response(
        `I|pong|Cache|gnutella\nH|44.0.0.1:6346|0\nU|${second}|0\n`,
      );
    },
  };
  return {
    state,
    calls,
    options,
    advance: (ms = hour) => {
      time += ms;
    },
  };
}

test("per-cache cooldowns survive restart without locking out another cache", async () => {
  const f = fixture();
  const persisted: GWebCacheBootstrapState[] = [];
  f.options.persist = async () => {
    persisted.push(structuredClone(f.state));
  };
  await fetchBootstrapData(f.options);
  expect(persisted[0].registry?.entries[first].nextAllowedAt).toBe(
    1_700_003_600,
  );
  const restarted: GWebCacheBootstrapState = {
    registry: structuredClone(f.state.registry),
  };
  await fetchBootstrapData({ ...f.options, state: restarted });
  expect(f.calls.map((url) => url.origin + url.pathname)).toEqual([
    first,
    second,
  ]);
  expect(restarted.aliveCaches).toEqual([second]);
  expect(
    (await fetchBootstrapData({ ...f.options, state: restarted }))
      .queriedCaches,
  ).toEqual([]);
});

test("hourly announcements do not block reads from a different cache", async () => {
  const f = fixture();
  await reportSelfToGWebCaches({ ...f.options, ip: "44.0.0.2:6346" });
  expect(
    (await reportSelfToGWebCaches({ ...f.options, ip: "44.0.0.2:6346" }))
      .attemptedCaches,
  ).toEqual([]);
  expect((await fetchBootstrapData(f.options)).queriedCaches).toEqual([
    second,
  ]);
});

test("selection does not fan out and respects injected randomness", async () => {
  const f = fixture();
  await fetchBootstrapData({
    ...f.options,
    caches: [first, second],
    random: () => 0.99,
  });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].hostname).toBe("second.example");
});

test.each([
  ["<html>broken</html>", 200],
  ["ERROR Unsupported network", 200],
  ["I|pong|Cache|gnutella2\nU|http://evil.example/|0", 200],
  ["I|net-not-supported\nU|http://evil.example/|0", 200],
  ["I|pong|Cache|gnutella\nH|44.0.0.1:6346|0", 503],
  ["", 200],
] as const)(
  "rejects unusable responses before accepting their records: %s",
  async (body, status) => {
    const f = fixture();
    let requests = 0;
    f.options.fetchImpl = async () => {
      requests++;
      return new Response(body, { status });
    };
    const result = await fetchBootstrapData(f.options);
    expect(result.peers).toEqual([]);
    expect(result.caches).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(f.state.registry?.entries[first].status).toBe("rejected");
    f.advance();
    await fetchBootstrapData(f.options);
    expect(requests).toBe(1);
  },
);

test("a failed cache does not block another cache and is not retried", async () => {
  const f = fixture();
  f.options.caches = [first, second];
  f.options.fetchImpl = async () => {
    throw new Error("offline");
  };
  expect((await fetchBootstrapData(f.options)).errors[0].message).toBe(
    "offline",
  );
  expect((await fetchBootstrapData(f.options)).queriedCaches).toEqual([
    second,
  ]);
  expect((await fetchBootstrapData(f.options)).queriedCaches).toEqual([]);
});

test.each([
  ["ERROR: Client returned too early\r\n", 200],
  ["Too many requests", 429],
] as const)(
  "rate limits preserve the cache and retry only after its cooldown: %s",
  async (body, status) => {
    const f = fixture();
    let requests = 0;
    f.options.fetchImpl = async () => {
      requests++;
      return new Response(body, { status });
    };
    const result = await fetchBootstrapData(f.options);
    expect(result.errors[0].message).toContain(body.trim());
    expect(f.state.registry?.entries[first].status).toBe("candidate");
    expect(result.peers).toEqual([]);
    expect((await fetchBootstrapData(f.options)).queriedCaches).toEqual(
      [],
    );
    expect(requests).toBe(1);
    f.advance();
    f.options.fetchImpl = async () =>
      new Response("I|pong|Cache|gnutella\nH|44.0.0.1:6346|0");
    expect((await fetchBootstrapData(f.options)).peers).toEqual([
      "44.0.0.1:6346",
    ]);
    expect(f.state.registry?.entries[first].status).toBe("verified");
    expect(f.state.registry?.entries[first].reason).toBeUndefined();
  },
);

test("concurrent requests reserve the budget before asynchronous persistence", async () => {
  const f = fixture();
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.options.persist = () => waiting;
  const pending = fetchBootstrapData(f.options);
  await reportSelfToGWebCaches({ ...f.options, ip: "44.0.0.2:6346" });
  expect(f.calls).toHaveLength(0);
  release();
  await pending;
  expect(f.calls).toHaveLength(1);
});

test("honors longer server periods including update periods without losing the update acknowledgement", async () => {
  const f = fixture();
  f.options.fetchImpl = async () =>
    new Response(
      "I|pong|Cache|gnutella\nI|update|OK\nI|update|period|10800\nI|access|period|7200",
    );
  const update = await reportSelfToGWebCaches({
    ...f.options,
    ip: "44.0.0.2:6346",
  });
  expect(update.reportedCaches).toEqual([first]);
  f.advance();
  expect((await fetchBootstrapData(f.options)).queriedCaches).toEqual([]);
  f.advance();
  expect((await fetchBootstrapData(f.options)).queriedCaches).toEqual([]);
  f.advance();
  expect((await fetchBootstrapData(f.options)).queriedCaches).toEqual([
    first,
  ]);
});

test("advertises only session-verified URLs and explicitly identifies the network on updates", async () => {
  const f = fixture();
  await reportSelfToGWebCaches({ ...f.options, ip: "44.0.0.2:6346" });
  expect(f.calls[0].searchParams.has("url")).toBe(false);
  expect(f.calls[0].searchParams.get("net")).toBe("gnutella");
  f.advance();
  await reportSelfToGWebCaches({ ...f.options, ip: "44.0.0.2:6346" });
  expect(f.calls[1].searchParams.get("url")).toBe(first);
});

test("old caches remain unverified until a returned peer completes a normal handshake", async () => {
  const f = fixture();
  f.options.fetchImpl = async () =>
    new Response(`H|44.0.0.1:6346|0\nU|${second}|0`);
  const connect = () =>
    connectBootstrapPeers({
      ...f.options,
      peers: [],
      connectConcurrency: 1,
      connectTimeoutMs: 50,

      availableSlots: () => 1,
      connectPeer: async () => {},
    });
  await connect();
  expect(f.state.registry?.entries[first].status).toBe("verified");
  expect(f.state.registry?.entries[second].status).toBe("candidate");
});

test("discovery is bounded and never promotes referrals solely on another cache's word", async () => {
  const f = fixture();
  const referrals = Array.from(
    { length: 100 },
    (_, i) => `U|http://cache${i}.example/|0`,
  );
  f.options.fetchImpl = async () =>
    new Response(
      [
        "I|pong|Cache|gnutella",
        ...referrals,
        "U|http://127.0.0.1/|0",
        "U|http://10.0.0.1/|0",
      ].join("\n"),
    );
  await fetchBootstrapData(f.options);
  expect(
    Object.values(f.state.registry!.entries).filter(
      (entry) => entry.status === "candidate",
    ),
  ).toHaveLength(50);
  expect(f.state.aliveCaches).toEqual([first]);
});

test.each([
  "http://127.0.0.1/",
  "http://[::1]/",
  "http://10.0.0.1/",
  "http://localhost/",
  "http://user:password@cache.example/",
  "file:///tmp/cache",
  "http://cache.example/?update=1",
])("rejects unsafe referral %s", (url) => {
  expect(referralUrl(url)).toBeUndefined();
});

test("a failed state save prevents the HTTP request without condemning the cache", async () => {
  const f = fixture();
  f.options.persist = async () => {
    throw new Error("disk full");
  };
  await expect(fetchBootstrapData(f.options)).rejects.toThrow("disk full");
  expect(f.calls).toHaveLength(0);
  expect(f.state.registry?.entries[first].status).toBe("candidate");
  expect(f.state.requestActive).toBe(false);
});

test("an unverified cache cannot introduce more referrals until it proves network support", async () => {
  const f = fixture();
  f.options.fetchImpl = async () =>
    new Response(`I|pong|OldCache\nU|${second}|0`);
  await fetchBootstrapData(f.options);
  expect(f.state.registry?.entries[first].status).toBe("candidate");
  expect(f.state.registry?.entries[second]).toBeUndefined();
  expect(f.state.aliveCaches).toBeUndefined();
});

test("each discovery tick queries one eligible cache without an hour-long global lockout", async () => {
  const f = fixture();
  const caches = Array.from(
    { length: 5 },
    (_, i) => `http://cache${i}.example/`,
  );
  const calls: string[] = [];
  const options: ConnectBootstrapOptions = {
    ...f.options,
    caches,
    peers: [],
    connectConcurrency: 1,
    connectTimeoutMs: 50,
    availableSlots: () => 1,
    connectPeer: async () => {
      throw new Error("offline");
    },
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response("I|pong|Cache|gnutella\n");
    },
  };
  for (let tick = 0; tick < 5; tick++) {
    await connectBootstrapPeers(options);
    expect(calls).toHaveLength(tick + 1);
    f.advance(15_000);
  }
  await connectBootstrapPeers(options);
  expect(calls).toHaveLength(5);
  expect(new Set(calls).size).toBe(5);
});

test("successive ticks move past dead caches and unusable peers to a working cache", async () => {
  const f = fixture();
  const third = "http://third.example/cache";
  const dialed: string[] = [];
  const options: ConnectBootstrapOptions = {
    ...f.options,
    caches: [first, second, third],
    peers: ["44.0.0.1:6346"],
    availableSlots: () => 1,
    connectConcurrency: 1,
    connectTimeoutMs: 50,
    canDialPeer: (host, port) => !dialed.includes(`${host}:${port}`),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "first.example")
        throw new Error("cache offline");
      return new Response(
        `I|pong|Cache|gnutella\nH|44.0.0.${url.hostname === "second.example" ? 1 : 2}:6346|0\n`,
      );
    },
    connectPeer: async (host, port) => {
      dialed.push(`${host}:${port}`);
      if (host === "44.0.0.1") throw new Error("stale peer");
    },
  };
  const queried: string[] = [];
  for (let tick = 0; tick < 3; tick++) {
    queried.push(...(await connectBootstrapPeers(options)).queriedCaches);
    f.advance(15_000);
  }
  expect(queried).toEqual([first, second, third]);
  expect(dialed).toEqual(["44.0.0.1:6346", "44.0.0.2:6346"]);
});

test("a local programming exception does not reject a cache or leave discovery active", async () => {
  const f = fixture();
  await expect(
    connectBootstrapPeers({
      ...f.options,
      peers: [],
      availableSlots: () => 1,
      connectConcurrency: 1,
      connectTimeoutMs: 50,
      connectPeer: async () => {},
      fetchImpl: async () => {
        throw new TypeError("local transport bug");
      },
    }),
  ).rejects.toThrow("local transport bug");
  expect(f.state.registry?.entries[first].status).toBe("candidate");
  expect(f.state.active).toBe(false);
  expect(f.state.requestActive).toBe(false);
});

test("cancellation prevents later discovery ticks from querying another cache", async () => {
  const f = fixture();
  const abort = new AbortController();
  const options: ConnectBootstrapOptions = {
    ...f.options,
    caches: [first, second],
    peers: [],
    availableSlots: () => 1,
    connectConcurrency: 1,
    connectTimeoutMs: 50,
    connectPeer: async () => {
      throw new Error("offline");
    },
    signal: abort.signal,
  };
  await connectBootstrapPeers(options);
  abort.abort();
  await connectBootstrapPeers(options);
  expect(f.calls).toHaveLength(1);
  expect(f.state.active).toBe(false);
});

test("working remembered peers and exhausted connection slots do not consume the cache budget", async () => {
  const f = fixture();
  const options = {
    ...f.options,
    peers: ["44.0.0.1:6346"],
    connectConcurrency: 1,
    connectTimeoutMs: 50,

    availableSlots: () => 1,
    connectPeer: async () => {},
  };
  await connectBootstrapPeers(options);
  await connectBootstrapPeers({
    ...options,
    peers: [],
    availableSlots: () => 0,
  });
  expect(f.calls).toHaveLength(0);
  expect(f.state.registry).toBeUndefined();
});

test("existing connections are skipped and remaining capacity uses the same discovery flow", async () => {
  const f = fixture();
  const connected = new Set(["44.0.0.1:6346"]);
  const dialed: string[] = [];
  const result = await connectBootstrapPeers({
    ...f.options,
    peers: [...connected],
    availableSlots: () => 2 - connected.size,
    canDialPeer: (host, port) => !connected.has(`${host}:${port}`),
    connectConcurrency: 1,
    connectTimeoutMs: 50,
    fetchImpl: async () =>
      new Response(
        "I|pong|Cache|gnutella\nH|44.0.0.1:6346|0\nH|44.0.0.2:6346|0",
      ),
    connectPeer: async (host, port) => {
      const peer = `${host}:${port}`;
      dialed.push(peer);
      connected.add(peer);
    },
  });
  expect(result.queriedCaches).toEqual([first]);
  expect(dialed).toEqual(["44.0.0.2:6346"]);
  expect(connected.size).toBe(2);
});
