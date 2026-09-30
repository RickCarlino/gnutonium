import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { scan } from "../../../src/cli/tokens";
import { detectLocalAdvertisedIpv4 } from "../../../src/config/document";
import type { Peer } from "../../../src/connections/types";
import { createCacheState } from "../../../src/discovery/gwebcache/state";
import { KNOWN_CACHES } from "../../../src/gwebcache_client";
import {
  buildGetRequest,
  buildHeader,
  defaultDoc,
  encodePong,
  encodePush,
  encodeQuery,
  loadDoc,
  parseHeader,
  parsePong,
  parsePush,
  parseQuery,
  writeDoc,
} from "../../../src/protocol";
import {
  bytesToIpLE,
  ensureDir,
  ipToBytesLE,
  normalizeIpv4,
  safeFileName,
} from "../../../src/shared";
import { parseByteRange } from "../../../src/wire/codec";
import { TestServent as GnutellaServent } from "../../helpers/servent";

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "protocol-cover-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makePeer(label = "1.2.3.4:6346"): Peer {
  return {
    key: label,
    socket: {
      destroy() {
        return this;
      },
    } as net.Socket,
    buf: Buffer.alloc(0),
    outbound: false,
    dialTarget: label,
    remoteLabel: label,
    role: "leaf",
    capabilities: {
      version: "0.6",
      headers: {},
      supportsGgep: true,
      supportsPongCaching: false,
      supportsBye: true,
      supportsCompression: false,
      supportsTls: false,
      compressIn: false,
      compressOut: false,
      isUltrapeer: false,
      ultrapeerNeeded: false,
      isCrawler: false,
      listenIp: { host: "5.6.7.8", port: 6347 },
    },
    remoteQrp: {
      resetSeen: false,
      tableSize: 0,
      infinity: 0,
      entryBits: 0,
      table: null,
      seqSize: 0,
      compressor: 0,
      parts: new Map<number, Buffer>(),
    },
    lastPingAt: 0,
    connectedAt: Date.now(),
  };
}

function expectReasonableRandomListenPort(port: number): void {
  expect(port).toBeGreaterThanOrEqual(20000);
  expect(port).toBeLessThanOrEqual(29999);
}

describe("protocol config and public helpers", () => {
  test("creates, persists, and normalizes config documents", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "nested", "protocol.json");
      const created = await loadDoc(configPath);
      const createdRuntime = new GnutellaServent(
        configPath,
        created,
      ).config();

      expect(created.config.dataDir).toBe(path.join(dir, "nested"));
      expect(created.config.advertisedHost).toBeUndefined();
      expect(created.config.advertisedPort).toBeUndefined();
      expect(Object.keys(created.config.gwebCaches!.entries)).toEqual([
        ...KNOWN_CACHES,
      ]);
      expect(Object.keys(createdRuntime.gwebCaches!.entries)).toEqual([
        ...KNOWN_CACHES,
      ]);
      expectReasonableRandomListenPort(createdRuntime.listenPort);
      expect(createdRuntime.maxConnections).toBe(64);
      expect(createdRuntime.maxUltrapeerConnections).toBe(64);
      expect(createdRuntime.maxLeafConnections).toBe(64);
      await expect(fs.stat(configPath)).resolves.toBeDefined();
      await expect(
        fs.stat(createdRuntime.downloadsDir),
      ).resolves.toBeDefined();

      created.state.peers = {
        "1.2.3.4:6346": 0,
        "9.9.9.9:6346": 123.9,
        invalid: 55,
      } as never;
      created.state.serventIdHex = "not-a-valid-id";

      await writeDoc(configPath, created);
      await fs.rm(createdRuntime.downloadsDir, {
        recursive: true,
        force: true,
      });

      const loaded = await loadDoc(configPath);
      const loadedRuntime = new GnutellaServent(
        configPath,
        loaded,
      ).config();
      const persisted = JSON.parse(
        await fs.readFile(configPath, "utf8"),
      ) as {
        config: Record<string, unknown>;
        state: Record<string, unknown>;
      };
      expect(loaded.state.peers).toEqual({
        "9.9.9.9:6346": 123,
        "1.2.3.4:6346": 0,
      });
      expect(loaded.config.dataDir).toBe(path.join(dir, "nested"));
      expect(loaded.config.advertisedHost).toBeUndefined();
      expect(Object.keys(loaded.config.gwebCaches!.entries)).toEqual([
        ...KNOWN_CACHES,
      ]);
      expect(loaded.state.serventIdHex).toMatch(/^[0-9a-f]{32}$/);
      expect(persisted.config.listen_ip).toBe("0.0.0.0");
      expect(persisted.config.listen_port).toBe(createdRuntime.listenPort);
      expect(Object.keys(persisted.config.gwebcaches as object)).toEqual([
        ...KNOWN_CACHES,
      ]);
      expect(persisted.config.max_connections).toBeUndefined();
      expect(persisted.config.max_ultrapeer_connections).toBe(64);
      expect(persisted.config.max_leaf_connections).toBe(64);
      expect(persisted.config.data_dir).toBe(path.join(dir, "nested"));
      expect(persisted.config.log_ignore).toBeUndefined();
      expect("listen_host" in persisted.config).toBe(false);
      expect("listenHost" in persisted.config).toBe(false);
      expect("dataDir" in persisted.config).toBe(false);
      expect(persisted.state.servent_id_hex).toMatch(/^[0-9a-f]{32}$/);
      expect("serventIdHex" in persisted.state).toBe(false);
      await expect(
        fs.stat(loadedRuntime.downloadsDir),
      ).resolves.toBeDefined();
    });
  });

  test("loads and persists gwebcache override urls", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      doc.config.gwebCaches = createCacheState([
        " http://127.0.0.1:6346/gwc.php ",
        "ftp://ignored.example.net/cache",
        "https://cache.example.net/g2/gwc.php#frag",
        "http://127.0.0.1:6346/gwc.php",
      ]);

      await writeDoc(configPath, doc);
      const loaded = await loadDoc(configPath);
      const runtime = new GnutellaServent(configPath, loaded).config();
      const persisted = JSON.parse(
        await fs.readFile(configPath, "utf8"),
      ) as {
        config: Record<string, unknown>;
      };

      expect(Object.keys(loaded.config.gwebCaches!.entries)).toEqual([
        "http://127.0.0.1:6346/gwc.php",
        "https://cache.example.net/g2/gwc.php",
      ]);
      expect(Object.keys(runtime.gwebCaches!.entries)).toEqual([
        "http://127.0.0.1:6346/gwc.php",
        "https://cache.example.net/g2/gwc.php",
      ]);
      expect(Object.keys(persisted.config.gwebcaches as object)).toEqual([
        "http://127.0.0.1:6346/gwc.php",
        "https://cache.example.net/g2/gwc.php",
      ]);
    });
  });

  test("creates a default config when the parent directory already exists", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");

      const created = await loadDoc(configPath);
      const runtime = new GnutellaServent(configPath, created).config();

      expect(created.config.dataDir).toBe(dir);
      await expect(fs.stat(configPath)).resolves.toBeDefined();
      await expect(fs.stat(runtime.downloadsDir)).resolves.toBeDefined();
    });
  });

  test("exposes peer user agents through public peer info", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const node = new GnutellaServent(configPath, defaultDoc(configPath));
      const peer = makePeer("1.2.3.4:6346");

      peer.capabilities.userAgent = "Peer/1.0";
      node.connections.peers.set(peer.key, peer as never);

      expect(node.getPeers()).toEqual([
        {
          key: "1.2.3.4:6346",
          remoteLabel: "1.2.3.4:6346",
          browseTarget: "5.6.7.8:6347",
          role: "leaf",
          outbound: false,
          dialTarget: "1.2.3.4:6346",
          compression: false,
          tls: false,
          userAgent: "Peer/1.0",
        },
      ]);
    });
  });

  test("ignores obsolete persisted keys instead of migrating them", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            config: {
              peers: ["1.2.3.4:6346", "9.9.9.9:6346"],
              seed_peers: ["3.4.5.6:6346"],
            },
            state: {
              servent_id_hex: "ab".repeat(16),
              known_peers: ["7.7.7.7:7777"],
              good_peers: ["8.8.8.8:8888"],
              downloads: [{ fileName: "stale.bin" }],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const loaded = await loadDoc(configPath);

      expect(loaded.state).toEqual({
        serventIdHex: "ab".repeat(16),
        peers: {},
      });
    });
  });

  test("persists explicit leaf and ultrapeer modes in config", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      doc.config.ultrapeer = true;

      await writeDoc(configPath, doc);
      const ultrapeerDoc = await loadDoc(configPath);
      expect(ultrapeerDoc.config.ultrapeer).toBe(true);
      expect(
        new GnutellaServent(configPath, ultrapeerDoc).config().nodeMode,
      ).toBe("ultrapeer");

      ultrapeerDoc.config.ultrapeer = false;
      await writeDoc(configPath, ultrapeerDoc);
      const leafDoc = await loadDoc(configPath);
      expect(leafDoc.config.ultrapeer).toBe(false);
      expect(
        new GnutellaServent(configPath, leafDoc).config().nodeMode,
      ).toBe("leaf");
    });
  });

  test("normalizes monitor ignore filters in config", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      doc.config.monitorIgnoreEvents = [
        " ping ",
        "PONG",
        "rx:ping",
        "",
        "PONG",
      ] as never;

      await writeDoc(configPath, doc);
      const loaded = await loadDoc(configPath);
      const runtime = new GnutellaServent(configPath, loaded).config();

      expect(loaded.config.monitorIgnoreEvents).toEqual([
        "PING",
        "PONG",
        "RX:PING",
      ]);
      expect(runtime.monitorIgnoreEvents).toEqual([
        "PING",
        "PONG",
        "RX:PING",
      ]);
    });
  });

  test("loads snake_case config keys and ignores camelCase aliases", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            config: {
              listen_ip: "127.0.0.1",
              listen_port: 7777,
              advertised_ip: "7.7.7.7",
              advertised_port: 8888,
              data_dir: "./state-dir",
              ultrapeer: true,
              max_ultrapeer_connections: 5,
              max_leaf_connections: 45,
              max_ttl: 9,
              log_ignore: [" ping ", "PONG"],
              seed_peers: ["1.2.3.4:6346"],
            },
            state: {
              servent_id_hex: "ab".repeat(16),
              known_peers: ["5.6.7.8:6346"],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const snakeLoaded = await loadDoc(configPath);
      expect(snakeLoaded.config.listenHost).toBe("127.0.0.1");
      expect(snakeLoaded.config.listenPort).toBe(7777);
      expect(snakeLoaded.config.advertisedHost).toBe("7.7.7.7");
      expect(snakeLoaded.config.advertisedPort).toBe(8888);
      expect(snakeLoaded.config.dataDir).toBe(path.join(dir, "state-dir"));
      expect(snakeLoaded.config.maxConnections).toBeUndefined();
      expect(snakeLoaded.config.maxUltrapeerConnections).toBe(5);
      expect(snakeLoaded.config.maxLeafConnections).toBe(45);
      expect(snakeLoaded.config.maxTtl).toBe(9);
      expect(snakeLoaded.config.monitorIgnoreEvents).toEqual([
        "PING",
        "PONG",
      ]);
      expect(
        new GnutellaServent(configPath, snakeLoaded).config().maxTtl,
      ).toBe(9);
      expect(snakeLoaded.state.serventIdHex).toBe("ab".repeat(16));
      expect(snakeLoaded.state.peers).toEqual({});

      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            config: {
              listenHost: "127.0.0.2",
              listenPort: 9999,
              advertisedHost: "8.8.8.8",
              advertisedPort: 9998,
              dataDir: "./legacy-dir",
              maxConnections: 99,
              maxUltrapeerConnections: 8,
              maxLeafConnections: 123,
              maxTtl: 12,
              monitorIgnoreEvents: ["query"],
              seedPeers: ["2.3.4.5:6346"],
            },
            state: {
              serventIdHex: "cd".repeat(16),
              goodPeers: ["6.7.8.9:6346"],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const camelLoaded = await loadDoc(configPath);
      expect(camelLoaded.config.listenHost).toBe("0.0.0.0");
      expectReasonableRandomListenPort(camelLoaded.config.listenPort);
      expect(camelLoaded.config.advertisedHost).toBeUndefined();
      expect(camelLoaded.config.advertisedPort).toBeUndefined();
      expect(camelLoaded.config.dataDir).toBe(dir);
      expect(camelLoaded.config.maxConnections).toBeUndefined();
      expect(camelLoaded.config.maxUltrapeerConnections).toBe(64);
      expect(camelLoaded.config.maxLeafConnections).toBe(64);
      expect(camelLoaded.config.maxTtl).toBe(4);
      expect(camelLoaded.config.monitorIgnoreEvents).toBeUndefined();
      expect(camelLoaded.state.serventIdHex).toMatch(/^[0-9a-f]{32}$/);
      expect(camelLoaded.state.serventIdHex).not.toBe("cd".repeat(16));
      expect(camelLoaded.state.peers).toEqual({});
    });
  });

  test("loads legacy host and max connection aliases", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            config: {
              listen_host: "127.0.0.1",
              listen_port: 7777,
              advertised_host: "7.7.7.7",
              max_connections: 15,
            },
            state: {
              servent_id_hex: "ab".repeat(16),
              peers: {},
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const loaded = await loadDoc(configPath);
      const runtime = new GnutellaServent(configPath, loaded).config();

      expect(loaded.config.listenHost).toBe("127.0.0.1");
      expect(loaded.config.advertisedHost).toBe("7.7.7.7");
      expect(loaded.config.maxConnections).toBeUndefined();
      expect(loaded.config.maxUltrapeerConnections).toBe(15);
      expect(runtime.maxConnections).toBe(15);
    });
  });

  test("detects advertised ipv4 addresses in routable-private-loopback order", () => {
    const original = os.networkInterfaces;

    try {
      expect(detectLocalAdvertisedIpv4("46.110.123.127")).toBe(
        "46.110.123.127",
      );

      (
        os as unknown as {
          networkInterfaces: typeof os.networkInterfaces;
        }
      ).networkInterfaces = () =>
        ({
          eth0: [
            {
              address: "10.0.0.5",
              family: "IPv4",
              internal: false,
            },
            {
              address: "46.110.123.127",
              family: "IPv4",
              internal: false,
            },
          ],
          lo: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
            },
          ],
        }) as unknown as ReturnType<typeof os.networkInterfaces>;
      expect(detectLocalAdvertisedIpv4("0.0.0.0")).toBe("46.110.123.127");

      (
        os as unknown as {
          networkInterfaces: typeof os.networkInterfaces;
        }
      ).networkInterfaces = () =>
        ({
          eth0: [
            {
              address: "10.0.0.5",
              family: "IPv4",
              internal: false,
            },
          ],
          lo: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
            },
          ],
        }) as unknown as ReturnType<typeof os.networkInterfaces>;
      expect(detectLocalAdvertisedIpv4("0.0.0.0")).toBe("10.0.0.5");

      (
        os as unknown as {
          networkInterfaces: typeof os.networkInterfaces;
        }
      ).networkInterfaces = () =>
        ({
          lo: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
            },
          ],
        }) as unknown as ReturnType<typeof os.networkInterfaces>;
      expect(detectLocalAdvertisedIpv4("0.0.0.0")).toBe("127.0.0.1");
    } finally {
      (
        os as unknown as {
          networkInterfaces: typeof os.networkInterfaces;
        }
      ).networkInterfaces = original;
    }
  });

  test("builds GET requests with Host headers and splits quoted args", () => {
    expect(
      buildGetRequest(12, "dir#/file name.txt", 128, "1.2.3.4", 6346),
    ).toBe(
      "GET /get/12/dir%23/file%20name.txt HTTP/1.1\r\nUser-Agent: Gnutonium/2.1.1\r\nHost: 1.2.3.4:6346\r\nConnection: Keep-Alive\r\nRange: bytes=128-\r\n\r\n",
    );

    expect(
      scan(
        `query "two words" 'three words' escaped\\ space plain\\\"quote`,
      ).map((t) => t.value),
    ).toEqual([
      "query",
      "two words",
      "three words",
      "escaped space",
      'plain"quote',
    ]);
    expect(
      scan(`query "" "two  words" plain\\ space`).map((t) => t.value),
    ).toEqual(["query", "", "two  words", "plain space"]);
  });

  test("parses query extensions, suffix byte ranges, and mapped ipv4 hosts", () => {
    const query = parseQuery(
      encodeQuery("", {
        urns: ["urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
        xmlBlocks: ["<xml/>", "{meta:true}"],
        requesterFirewalled: true,
        wantsXml: true,
        leafGuidedDynamic: true,
        ggepHAllowed: true,
        outOfBand: true,
        maxHits: 999,
      }),
    );

    expect(query.search).toBe("");
    expect(query.urns).toEqual([
      "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ]);
    expect(query.xmlBlocks).toEqual(["<xml/>", "{meta:true}"]);
    expect(query.requesterFirewalled).toBe(true);
    expect(query.wantsXml).toBe(true);
    expect(query.leafGuidedDynamic).toBe(true);
    expect(query.ggepHAllowed).toBe(true);
    expect(query.outOfBand).toBe(true);
    expect(query.maxHits).toBe(0x1ff);

    expect(parseByteRange("bytes=-5", 10)).toEqual({
      start: 5,
      end: 9,
      partial: true,
    });
    expect(parseByteRange("bytes=-20", 10)).toEqual({
      start: 0,
      end: 9,
      partial: false,
    });
    expect(parseByteRange("bytes=-0", 10)).toBeNull();

    expect(normalizeIpv4(" ::ffff:1.2.3.4 ")).toBe("1.2.3.4");
    expect(normalizeIpv4("::ffff:999.2.3.4")).toBeUndefined();
  });

  test("tolerates existing directories from mkdir races", async () => {
    const originalMkdir = fs.mkdir;
    const originalStat = fs.stat;

    try {
      (
        fs as unknown as {
          mkdir: typeof fs.mkdir;
          stat: typeof fs.stat;
        }
      ).mkdir = (async () => {
        const error = Object.assign(new Error("exists"), {
          code: "EEXIST",
        });
        throw error;
      }) as typeof fs.mkdir;
      (
        fs as unknown as {
          mkdir: typeof fs.mkdir;
          stat: typeof fs.stat;
        }
      ).stat = (async () =>
        ({
          isDirectory: () => true,
        }) as never) as typeof fs.stat;

      await expect(
        ensureDir("/tmp/existing-dir"),
      ).resolves.toBeUndefined();

      (
        fs as unknown as {
          mkdir: typeof fs.mkdir;
          stat: typeof fs.stat;
        }
      ).stat = (async () =>
        ({
          isDirectory: () => false,
        }) as never) as typeof fs.stat;

      await expect(ensureDir("/tmp/existing-file")).rejects.toThrow(
        "exists",
      );
    } finally {
      (
        fs as unknown as {
          mkdir: typeof fs.mkdir;
          stat: typeof fs.stat;
        }
      ).mkdir = originalMkdir;
      (
        fs as unknown as {
          mkdir: typeof fs.mkdir;
          stat: typeof fs.stat;
        }
      ).stat = originalStat;
    }
  });

  test("round-trips public protocol helpers and sanitizes filenames", () => {
    const descriptorId = Buffer.from(
      "00112233445566778899aabbccddeeff",
      "hex",
    );
    const payload = Buffer.from("hello", "utf8");
    const frame = buildHeader(descriptorId, 0x80, 7, 2, payload);
    const parsed = parseHeader(frame.subarray(0, 23));

    expect(parsed).toEqual({
      descriptorId,
      descriptorIdHex: "00112233445566778899aabbccddeeff",
      payloadType: 0x80,
      ttl: 7,
      hops: 2,
      payloadLength: 5,
    });
    expect(frame.subarray(23)).toEqual(payload);

    expect(ipToBytesLE("1.2.3.4")).toEqual(Buffer.from([4, 3, 2, 1]));
    expect(bytesToIpLE(Buffer.from([4, 3, 2, 1]))).toBe("1.2.3.4");
    expect(safeFileName("dir/name\0bin")).toBe("dir_name_bin");
    expect(safeFileName("...")).toBe("_");

    const ggep = Buffer.from([0xc3, 0x01, 0x02]);
    expect(parsePong(encodePong(6346, "5.6.7.8", 12, 34, ggep))).toEqual({
      port: 6346,
      ip: "5.6.7.8",
      files: 12,
      kbytes: 34,
      ggep,
    });

    const serventId = Buffer.from(
      "ffeeddccbbaa99887766554433221100",
      "hex",
    );
    const pushPayload = Buffer.concat([
      encodePush(serventId, 9, "9.8.7.6", 4321),
      ggep,
    ]);
    expect(parsePush(pushPayload)).toEqual({
      serventId,
      serventIdHex: serventId.toString("hex"),
      fileIndex: 9,
      ip: "9.8.7.6",
      port: 4321,
      ggep,
    });
  });

  test("rejects malformed public protocol helper inputs", () => {
    expect(() => ipToBytesLE("300.2.3.4")).toThrow("invalid IPv4 address");
    expect(() => bytesToIpLE(Buffer.from([1, 2, 3]))).toThrow(
      "expected 4 bytes for IPv4, got 3",
    );
    expect(() => parsePong(Buffer.alloc(13))).toThrow(
      "invalid pong length 13",
    );
    expect(() => parsePush(Buffer.alloc(25))).toThrow(
      "invalid push length 25",
    );
  });

  test("emits maintenance events, manages timers, and reports peer dial state", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const node = new GnutellaServent(configPath, doc);
      const events: string[] = [];
      const unsubscribe = node.subscribe((event) =>
        events.push(event.type),
      );

      node.emitMaintenanceError("SAVE", new Error("disk full"));
      node.schedule(60_000, () => void 0);

      expect(events).toEqual(["MAINTENANCE_ERROR"]);
      expect(node.connections.peerCount()).toBe(0);
      expect(node.config()).toMatchObject({
        dataDir: dir,
        downloadsDir: path.join(dir, "downloads"),
      });

      node.connections.dialing.add("1.2.3.4:6346");
      expect(node.connections.peerDialState("1.2.3.4", 6346)).toBe(
        "dialing",
      );
      node.connections.dialing.clear();

      node.connections.peers.set("p1", makePeer() as never);
      expect(node.connections.peerDialState("1.2.3.4", 6346)).toBe(
        "connected",
      );
      expect(node.connections.peerDialState("5.6.7.8", 6347)).toBe(
        "connected",
      );
      expect(node.connections.peerDialState("8.8.8.8", 6346)).toBe("none");

      unsubscribe();
      node.emitMaintenanceError("SAVE", "ignored after unsubscribe");
      expect(events).toEqual(["MAINTENANCE_ERROR"]);

      await node.stop();
    });
  });
});
