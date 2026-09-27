import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createCacheState } from "../../src/discovery/gwebcache/state";
import { requestPinnedCache } from "../../src/discovery/gwebcache/transport";
import {
  connectBootstrapPeers,
  KNOWN_CACHES,
} from "../../src/gwebcache_client";
import { defaultDoc, loadDoc } from "../../src/protocol";
import { makeNode, withTempDir } from "../helpers/protocol";
import { TestServent } from "../helpers/servent";

// The cache advertises a routable fixture address; the injected bootstrap connector
// maps it to a real localhost Gnutella handshake without contacting public peers.
test("empty-peer bootstrap makes one cache request, connects, and persists referrals and cooldown across restart", async () => {
  await withTempDir(async (dir) => {
    let requests = 0;
    let time = 1_700_000_000_000;
    const sockets = new Set<net.Socket>();
    const peer = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", () =>
        socket.write(
          "GNUTELLA/0.6 200 OK\r\nUser-Agent: CacheFixture/1.0\r\nX-Ultrapeer: True\r\n\r\n",
        ),
      );
    });
    await new Promise<void>((resolve) =>
      peer.listen(0, "127.0.0.1", resolve),
    );
    const peerPort = (peer.address() as net.AddressInfo).port;
    const cache = http.createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(
        `I|pong|Fixture|gnutella\r\nH|44.0.0.1:${peerPort}|0\r\nU|http://discovered.example/cache|0\r\nU|http://127.0.0.1/private|0\r\n`,
      );
    });
    await new Promise<void>((resolve) =>
      cache.listen(0, "127.0.0.1", resolve),
    );
    const cacheUrl = `http://127.0.0.1:${(cache.address() as net.AddressInfo).port}/cache`;
    const configPath = path.join(dir, "config.json");
    const node = makeNode(configPath, {
      runtimeConfig: {
        gwebCaches: createCacheState([cacheUrl]),
        enableTls: false,
      },
      collaborators: {
        clock: { now: () => time },
        bootstrapClient: {
          connectBootstrapPeers: (options) =>
            connectBootstrapPeers({
              ...options,
              // Explicit transport override for this localhost-only fixture.
              fetchImpl: fetch,
              connectPeer: (_host, port, timeoutMs) =>
                options.connectPeer("127.0.0.1", port, timeoutMs),
            }),
        },
      },
    });
    try {
      expect(node.getKnownPeers()).toEqual([]);
      await node.discovery.connectKnownPeers();
      expect(node.connections.peerCount()).toBe(1);
      expect(requests).toBe(1);
      expect(
        node.config().gwebCaches.entries["http://discovered.example/cache"]
          .status,
      ).toBe("candidate");
      node.updateRuntimeConfig({ downloadQueueSize: 3 });
      await node.stop();
      const doc = await loadDoc(configPath);
      expect(doc.config.gwebCaches?.entries[cacheUrl].status).toBe(
        "verified",
      );
      expect(
        doc.config.gwebCaches?.entries["http://discovered.example/cache"]
          .status,
      ).toBe("candidate");
      expect(doc.config.gwebCaches?.entries).not.toHaveProperty(
        "http://127.0.0.1/private",
      );
      expect(doc.config.gwebCaches?.entries[cacheUrl].nextAllowedAt).toBe(
        time / 1000 + 3600,
      );
      doc.state.peers = {};
      time += 1000;
      const restarted = new TestServent(configPath, doc, {
        collaborators: {
          clock: { now: () => time },
          bootstrapClient: {
            connectBootstrapPeers: (options) =>
              connectBootstrapPeers({
                ...options,
                fetchImpl: async (input) => {
                  expect(new URL(String(input)).hostname).toBe(
                    "discovered.example",
                  );
                  return new Response("I|pong|Fixture|gnutella\n");
                },
              }),
          },
        },
      });
      try {
        expect(
          restarted.discovery.gwebCacheBootstrapState.aliveCaches,
        ).toBeUndefined();
        await restarted.discovery.connectKnownPeers();
        expect(requests).toBe(1);
        expect(
          restarted.discovery.gwebCacheBootstrapState.aliveCaches,
        ).toEqual(["http://discovered.example/cache"]);
      } finally {
        await restarted.stop();
      }
    } finally {
      await node.stop();
      for (const socket of sockets) socket.destroy();
      cache.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => peer.close(() => resolve())),
        new Promise<void>((resolve) => cache.close(() => resolve())),
      ]);
    }
  });
});

test("an empty or missing cache config is populated on disk, and custom seeds remain intact", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "config.json");
    const doc = defaultDoc(configPath);
    doc.config.dataDir = dir;
    for (const caches of [
      undefined,
      [],
      ["http://custom.example/cache"],
    ]) {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          config: { data_dir: dir, gwebcache_urls: caches },
          state: { peers: {} },
        }),
      );
      const loaded = await loadDoc(configPath);
      expect(Object.keys(loaded.config.gwebCaches!.entries)).toEqual(
        caches?.length ? caches : [...KNOWN_CACHES],
      );
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(Object.keys(saved.config.gwebcaches)).toEqual(
        caches?.length ? caches : [...KNOWN_CACHES],
      );
    }
  });
});

test("native cache HTTP transport connects to the pinned address and preserves Host", async () => {
  let host: string | undefined;
  const server = http.createServer((request, response) => {
    host = request.headers.host;
    response.end("I|pong|Fixture|gnutella\nH|44.0.0.1:6346|0\n");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as net.AddressInfo).port;
  try {
    // .invalid cannot resolve: this exercises the real HTTP stack's lookup contract.
    // The loopback pin is an explicit fixture override of public-address validation.
    const response = await requestPinnedCache(
      new URL(`http://cache.invalid:${port}/`),
      "127.0.0.1",
      { signal: AbortSignal.timeout(2000) },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("I|pong|Fixture|gnutella");
    expect(host).toBe(`cache.invalid:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
