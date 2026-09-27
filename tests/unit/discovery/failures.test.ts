import { expect, test } from "bun:test";
import { createCacheState } from "../../../src/discovery/gwebcache/state";
import { PeerDiscovery } from "../../../src/discovery/runtime";
import { connectBootstrapPeers } from "../../../src/gwebcache_client";
import type { PeerState } from "../../../src/types";

const now = 1_700_000_000;
const target = "44.0.0.1:6346";

function timeout(): Error {
  return Object.assign(new Error("connect timeout"), {
    code: "ETIMEDOUT",
  });
}

function discovery(
  peers: PeerState,
  connectPeer: (host: string, port: number) => Promise<void>,
  cachePeers: string[] = [],
): PeerDiscovery {
  return new PeerDiscovery(
    {
      config: () => ({
        blockedIps: [],
        peerSeenThresholdSec: 60,
        gwebCaches: createCacheState(["http://cache.test/"]),
        vendorCode: "TEST",
        userAgent: "Test/1.0",
        maxLeafConnections: 4,
        connectTimeoutMs: 100,
      }),
      now: () => now * 1000,
      startedAtMs: () => now * 1000,
      scheduler: { setTimeout, clearTimeout },
      isSelfPeer: () => false,
      isBlockedHost: () => false,
      peerCount: () => 0,
      nodeMode: () => "leaf",
      connectedLeafCount: () => 0,
      connectedMeshPeerCount: () => 0,
      availableDialSlots: () => 4,
      isPeerBusy: () => false,
      connectPeer,
      currentAdvertisedHost: () => "127.0.0.1",
      currentAdvertisedPort: () => 6346,
      onError: (error) => {
        throw error;
      },
      connectBootstrapPeers: (options) =>
        connectBootstrapPeers({
          ...options,
          fetchImpl: async () =>
            new Response(
              cachePeers.map((peer) => `H|${peer}|0`).join("\n"),
            ),
        }),
      reportSelfToGWebCaches: async () => ({
        attemptedCaches: [],
        reportedCaches: [],
        errors: [],
      }),
    },
    peers,
  );
}

test("timeouts are forgotten and rediscovery cannot redial them during the session", async () => {
  const dialed: string[] = [];
  const alternate = "44.0.0.1:6347";
  const node = discovery(
    { [target]: now },
    async (host, port) => {
      dialed.push(`${host}:${port}`);
      if (port === 6346) throw timeout();
    },
    [target, alternate],
  );

  await node.connectKnownPeers();
  expect(node.snapshot()).not.toHaveProperty(target);
  node.addKnownPeer("44.0.0.1", 6346);
  expect(node.getKnownPeers()).not.toContain(target);
  await node.connectKnownPeers();

  expect(dialed).toEqual([target, alternate, alternate]);
  expect(node.snapshot()).toEqual({ [alternate]: 0 });
});

test.each([
  "connect timeout",
  "connect ECONNREFUSED",
  "GNUTELLA/0.6 204 Shielded leaf node",
  "GNUTELLA/0.6 409 Already connected",
  "GNUTELLA/0.6 429 Banned for 5m 0s",
  "GNUTELLA/0.6 503 I am busy",
])("automatic discovery gives up after %s", async (message) => {
  let attempts = 0;
  const node = discovery(
    { [target]: now },
    async () => {
      attempts += 1;
      throw new Error(message);
    },
    [target],
  );
  await node.connectKnownPeers();
  await node.connectKnownPeers();
  expect(attempts).toBe(1);
  expect(node.snapshot()).toEqual({});
});

test("a stable connection restores a timed-out endpoint", async () => {
  let attempts = 0;
  const node = discovery({ [target]: now }, async () => {
    attempts += 1;
    if (attempts === 1) throw timeout();
  });
  await node.connectKnownPeers();
  node.markPeerSeenIfStable({
    connectedAt: now * 1000 - 61_000,
    dialTarget: target,
    capabilities: {},
  });
  expect(node.snapshot()).toEqual({ [target]: now });
  await node.connectKnownPeers();
  expect(attempts).toBe(2);
});

test("a new session may rediscover a forgotten endpoint", async () => {
  const first = discovery({ [target]: now }, async () => {
    throw timeout();
  });
  await first.connectKnownPeers();
  let attempts = 0;
  const restarted = discovery(
    first.snapshot(),
    async () => {
      attempts += 1;
    },
    [target],
  );
  await restarted.connectKnownPeers();
  expect(attempts).toBe(1);
});

test("discovery passes do not overlap and the guard clears after completion", async () => {
  let attempts = 0;
  const pending = Promise.withResolvers<void>();
  const node = discovery({ [target]: now }, async () => {
    attempts += 1;
    await pending.promise;
  });
  const first = node.connectKnownPeers();
  await node.connectKnownPeers();
  expect(attempts).toBe(1);
  pending.resolve();
  await first;
  await node.connectKnownPeers();
  expect(attempts).toBe(2);
});
