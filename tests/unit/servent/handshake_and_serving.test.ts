import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { TYPE } from "../../../src/const";
import {
  buildUriResRequest,
  encodeBye,
  encodeQuery,
  parseBye,
  parseHeader,
  parseQueryHit,
} from "../../../src/protocol";
import { parseGgep } from "../../../src/wire/ggep";
import {
  makeHeader,
  makeNode,
  makePeer,
  makeShare,
  MockSocket,
  overrideRuntimeConfig,
  peerState,
  withMockNetworkInterfaces,
  withTempDir,
} from "../../helpers/protocol";

async function waitForShareHashes(node: {
  getShares(): Array<{ sha1Urn?: string }>;
  shareLibrary: { shareHashTask: Promise<void> | null };
}): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (
      node.shareLibrary.shareHashTask === null &&
      node
        .getShares()
        .every((share) =>
          /^urn:sha1:[A-Z2-7]{32}$/.test(share.sha1Urn || ""),
        )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for background share hashing");
}

describe("protocol node", () => {
  test("accepts non-empty ping payloads and NUL-terminates Bye messages", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      expect(
        node.connections.validateDescriptor(
          TYPE.PING,
          Buffer.from([0xc3, 0x90, 0x00]),
        ),
      ).toBe(true);

      const encoded = encodeBye(502, "queue full");
      expect(encoded.at(-1)).toBe(0);
      expect(
        parseBye(Buffer.concat([encoded, Buffer.from("ignored", "utf8")])),
      ).toEqual({
        code: 502,
        message: "queue full",
      });
    });
  });

  test("normalizes query TTL plus hops and drops excessive query TTL values", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      overrideRuntimeConfig(node, {
        ultrapeer: true,
        nodeMode: "ultrapeer",
        maxTtl: 7,
      });
      const peer = makePeer("source-peer");
      peer.role = "ultrapeer";
      const other = makePeer("other-peer");
      other.role = "ultrapeer";
      node.connections.peers.set(other.key, other);
      let forwarded: {
        ttl: number;
        hops: number;
        descriptorId: string;
      } | null = null;
      let responded = false;
      node.connections.sendToPeer = (
        target: { key: string },
        payloadType: number,
        descriptorId: Buffer,
        ttl: number,
        hops: number,
        _payload: Buffer,
      ) => {
        if (target.key !== other.key || payloadType !== TYPE.QUERY) return;
        forwarded = {
          ttl,
          hops,
          descriptorId: descriptorId.toString("hex"),
        };
      };
      node.router.respondQueryHit = () => {
        responded = true;
      };

      const payload = encodeQuery("alpha");
      node.router.handleDescriptor(
        peer as never,
        makeHeader(TYPE.QUERY, 7, 4, 0x11),
        payload,
      );

      expect(responded).toBe(true);
      expect(forwarded!).toEqual({
        ttl: 2,
        hops: 5,
        descriptorId: "11".repeat(16),
      });

      forwarded = null;
      responded = false;
      node.router.handleDescriptor(
        peer as never,
        makeHeader(TYPE.QUERY, 16, 0, 0x12),
        payload,
      );

      expect(responded).toBe(false);
      expect(forwarded).toBeNull();
    });
  });

  test("ignores blank queries but answers the four-space index query", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        const shareA = makeShare(
          1,
          path.join(dir, "alpha.txt"),
          "alpha.txt",
        );
        const shareB = makeShare(
          2,
          path.join(dir, "beta.bin"),
          "beta.bin",
        );
        delete shareA.sha1;
        delete shareA.sha1Urn;
        node.shareLibrary.shares = [shareA, shareB];
        node.shareLibrary.sharesByIndex = new Map(
          node.shareLibrary.shares.map((share) => [share.index, share]),
        );
        const peer = makePeer();
        const sent: Array<{ payloadType: number; payload: Buffer }> = [];
        node.connections.sendToPeer = (
          _peer: unknown,
          payloadType: number,
          _descriptorId: Buffer,
          _ttl: number,
          _hops: number,
          payload: Buffer,
        ) => {
          sent.push({ payloadType, payload });
        };
        node.router.broadcastQuery = () => {};

        node.router.handleDescriptor(
          peer as never,
          makeHeader(TYPE.QUERY, 2, 0, 0x21),
          encodeQuery("   "),
        );
        expect(sent).toHaveLength(0);

        node.router.handleDescriptor(
          peer as never,
          makeHeader(TYPE.QUERY, 1, 0, 0x22),
          encodeQuery("    "),
        );
        expect(sent).toHaveLength(1);
        expect(sent[0].payloadType).toBe(TYPE.QUERY_HIT);
        const results = parseQueryHit(sent[0].payload).results;
        expect(results.map((result) => result.fileName)).toEqual([
          "alpha.txt",
          "beta.bin",
        ]);
        expect(results[0]?.urns).toEqual([]);
        expect(results[1]?.urns).toEqual([shareB.sha1Urn!]);

        sent.length = 0;
        node.router.handleDescriptor(
          peer as never,
          makeHeader(TYPE.QUERY, 2, 0, 0x23),
          encodeQuery("a b"),
        );
        expect(sent).toHaveLength(0);
      });
    });
  });

  test("answers SHA1-only queries that carry the URN in the search field", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        const share = makeShare(
          1,
          path.join(dir, "FW2PQUDZ.txt"),
          "FW2PQUDZ.txt",
        );
        node.shareLibrary.shares = [share];
        node.shareLibrary.sharesByIndex = new Map([[share.index, share]]);
        node.shareLibrary.sharesByUrn = new Map([
          [share.sha1Urn!.toLowerCase(), share],
        ]);
        const peer = makePeer();
        const sent: Array<{ payloadType: number; payload: Buffer }> = [];
        node.connections.sendToPeer = (
          _peer: unknown,
          payloadType: number,
          _descriptorId: Buffer,
          _ttl: number,
          _hops: number,
          payload: Buffer,
        ) => {
          sent.push({ payloadType, payload });
        };
        node.router.broadcastQuery = () => {};

        node.router.handleDescriptor(
          peer as never,
          makeHeader(TYPE.QUERY, 2, 0, 0x24),
          encodeQuery(share.sha1Urn!),
        );

        expect(sent).toHaveLength(1);
        expect(sent[0].payloadType).toBe(TYPE.QUERY_HIT);
        const results = parseQueryHit(sent[0].payload).results;
        expect(results).toHaveLength(1);
        expect(results[0]?.fileName).toBe("FW2PQUDZ.txt");
        expect(results[0]?.urns).toEqual([share.sha1Urn!]);
      });
    });
  });

  test("accepts both /get path spellings on inbound requests", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const share = makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt");
      node.shareLibrary.sharesByIndex = new Map([[share.index, share]]);
      const socket = new MockSocket();
      const heads: string[] = [];
      node.transfers.handleExistingGet = async (
        _socket: net.Socket,
        head: string,
      ) => {
        heads.push(head);
        return false;
      };

      await node.transfers.handleIncomingGet(
        socket as never,
        "GET /get/1/alpha.txt HTTP/1.1\r\n\r\n",
      );
      await node.transfers.handleIncomingGet(
        socket as never,
        "GET /get/1/alpha.txt/ HTTP/1.1\r\n\r\n",
      );

      expect(heads).toEqual([
        "GET /get/1/alpha.txt HTTP/1.1\r\n\r\n",
        "GET /get/1/alpha.txt/ HTTP/1.1\r\n\r\n",
      ]);
    });
  });

  test("refreshes shares immediately and reuses cached SHA-1 URNs on the next scan", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const node = makeNode(configPath);
      await fs.mkdir(path.join(node.config().downloadsDir, "nested"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(node.config().downloadsDir, "caf\u00e9-au-lait.txt"),
        "hello",
        "utf8",
      );
      await fs.writeFile(
        path.join(node.config().downloadsDir, "nested", "second-file.bin"),
        "1234567890",
        "utf8",
      );
      await fs.writeFile(
        path.join(node.config().downloadsDir, "nested", "cats-track.txt"),
        "meow",
        "utf8",
      );

      await node.refreshShares();

      expect(node.getShares().map((share) => share.rel)).toEqual([
        "caf\u00e9-au-lait.txt",
        "nested/cats-track.txt",
        "nested/second-file.bin",
      ]);
      expect(node.getShares()[0]?.keywords).toEqual(
        expect.arrayContaining(["cafe", "au", "lait", "txt"]),
      );
      expect(node.getShares()[1]?.keywords).toEqual(
        expect.arrayContaining(["nested", "cats", "track", "txt"]),
      );
      expect(node.getShares()[2]?.keywords).toEqual(
        expect.arrayContaining(["nested", "second", "file", "bin"]),
      );
      expect(node.router.qrpTable.matchesQuery("cafe lait")).toBe(true);
      expect(node.router.qrpTable.matchesQuery("cats track")).toBe(true);
      expect(node.router.qrpTable.matchesQuery("missing-token")).toBe(
        false,
      );
      expect(node.shareLibrary.totalSharedKBytes()).toBe(1);

      await waitForShareHashes(node);
      expect(
        node
          .getShares()
          .every((share) =>
            /^urn:sha1:[A-Z2-7]{32}$/.test(share.sha1Urn || ""),
          ),
      ).toBe(true);

      const cachedNode = makeNode(configPath);
      await cachedNode.refreshShares();
      expect(
        cachedNode
          .getShares()
          .every((share) =>
            /^urn:sha1:[A-Z2-7]{32}$/.test(share.sha1Urn || ""),
          ),
      ).toBe(true);
    });
  });

  test("builds handshake headers, capabilities, and rejection responses with try peers", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        overrideRuntimeConfig(node, {
          advertisedHost: "7.7.7.7",
          advertisedPort: 7777,
        });
        node.discovery.knownPeers = peerState([
          ["7.7.7.7:7777", 0],
          ["1.1.1.1:1234", 0],
        ]);

        expect(node.connections.baseHandshakeHeaders()).toMatchObject({
          "user-agent": "Gnutonium/2.1.1",
          "x-ultrapeer": "False",
          "listen-ip": "7.7.7.7:7777",
          "x-max-ttl": "4",
          "x-query-routing": "0.2",
          "accept-encoding": "deflate",
          "pong-caching": "0.1",
          ggep: "0.5",
          "bye-packet": "0.1",
        });
        expect(
          node.connections.buildServerHandshakeHeaders(
            { "accept-encoding": "gzip, deflate" },
            "9.8.7.6",
          ),
        ).toMatchObject({
          "content-encoding": "deflate",
          "remote-ip": "9.8.7.6",
        });
        expect(
          node.connections.buildServerHandshakeHeaders(
            {
              upgrade: "TLS/1.0",
              "accept-encoding": "gzip, deflate",
            },
            "9.8.7.6",
          ),
        ).toMatchObject({
          upgrade: "TLS/1.0",
          connection: "Upgrade",
          "content-encoding": "deflate",
          "remote-ip": "9.8.7.6",
        });
        expect(
          node.connections.buildClientFinalHeaders(
            { "accept-encoding": "deflate" },
            "9.8.7.6",
          ),
        ).toEqual({
          "content-encoding": "deflate",
          "remote-ip": "9.8.7.6",
        });
        expect(
          node.connections.buildClientFinalHeaders(
            {
              upgrade: "TLS/1.0",
              connection: "Upgrade",
              "accept-encoding": "deflate",
            },
            "9.8.7.6",
          ),
        ).toEqual({
          connection: "Upgrade",
          "content-encoding": "deflate",
          "remote-ip": "9.8.7.6",
        });

        const caps = node.connections.buildCapabilities(
          "0.6",
          {
            "User-Agent": "Peer/1.0",
            "Accept-Encoding": "gzip, deflate",
            Upgrade: "TLS/1.0",
            "X-Ultrapeer": "True",
            "X-Ultrapeer-Needed": "false",
            "Listen-IP": "9.8.7.6:6346",
            "X-Query-Routing": "0.2",
            "X-Ultrapeer-Query-Routing": "0.1",
            "X-Dynamic-Querying": "0.1",
            "X-Ext-Probes": "0.1",
            "X-Degree": "32",
            GGEP: "0.5",
            "Pong-Caching": "0.1",
            "Bye-Packet": "0.1",
          },
          true,
          false,
        );
        expect(caps).toMatchObject({
          userAgent: "Peer/1.0",
          supportsGgep: true,
          supportsPongCaching: true,
          supportsBye: true,
          supportsCompression: true,
          supportsTls: true,
          compressIn: true,
          compressOut: false,
          isUltrapeer: true,
          ultrapeerNeeded: false,
          queryRoutingVersion: "0.2",
          ultrapeerQueryRoutingVersion: "0.1",
          dynamicQueryingVersion: "0.1",
          extProbesVersion: "0.1",
          degree: 32,
          listenIp: { host: "9.8.7.6", port: 6346 },
        });

        const listenPeer = makePeer("2.2.2.2:2345");
        listenPeer.capabilities.listenIp = { host: "2.2.2.2", port: 2345 };
        const dialedPeer = makePeer("3.3.3.3:3456");
        dialedPeer.dialTarget = "3.3.3.3:3456";
        node.connections.peers.set(listenPeer.key, listenPeer as never);
        node.connections.peers.set(dialedPeer.key, dialedPeer as never);

        expect(node.connections.selectTryPeers(4)).toEqual([
          "2.2.2.2:2345",
          "3.3.3.3:3456",
          "1.1.1.1:1234",
        ]);

        const socket = new MockSocket();
        node.connections.reject06(socket as never, 503, "Busy", {
          server: "TestServent",
        });
        const raw = Buffer.concat(socket.writes).toString("latin1");
        expect(socket.ended).toBe(true);
        expect(raw).toContain("GNUTELLA/0.6 503 Busy\r\n");
        expect(raw).toContain(
          "X-Try: 2.2.2.2:2345,3.3.3.3:3456,1.1.1.1:1234\r\n",
        );
        expect(raw).toContain(
          "X-Try-Ultrapeers: 2.2.2.2:2345,3.3.3.3:3456,1.1.1.1:1234\r\n",
        );
        expect(raw.toLowerCase()).toContain("server: testservent\r\n");

        node.connections.maybeAbsorbTryHeaders({
          "x-try": "4.4.4.4:4444, invalid, 2.2.2.2:2345",
          "x-try-ultrapeers": "5.5.5.5:5555",
        });
        expect(node.getKnownPeers()).toEqual(
          expect.arrayContaining([
            "1.1.1.1:1234",
            "4.4.4.4:4444",
            "5.5.5.5:5555",
          ]),
        );
      });
    });
  });

  test("updates ultrapeer handshake headers as mesh and leaf slots fill", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        overrideRuntimeConfig(node, {
          ultrapeer: true,
          nodeMode: "ultrapeer",
          maxConnections: 1,
          maxLeafConnections: 1,
        });

        expect(node.connections.baseHandshakeHeaders()).toMatchObject({
          "x-ultrapeer": "True",
          "x-ultrapeer-needed": "True",
          "x-ultrapeer-query-routing": "0.1",
          "x-dynamic-querying": "0.1",
          "x-ext-probes": "0.1",
          "x-degree": "16",
        });

        const meshPeer = makePeer("11.11.11.11:1111");
        meshPeer.role = "ultrapeer";
        meshPeer.capabilities.isUltrapeer = true;
        node.connections.peers.set(meshPeer.key, meshPeer);

        expect(node.connections.baseHandshakeHeaders()).toMatchObject({
          "x-ultrapeer": "True",
          "x-ultrapeer-needed": "False",
          "x-ultrapeer-query-routing": "0.1",
          "x-dynamic-querying": "0.1",
          "x-ext-probes": "0.1",
          "x-degree": "16",
        });

        const leafPeer = makePeer("12.12.12.12:1212");
        node.connections.peers.set(leafPeer.key, leafPeer);

        expect(node.connections.baseHandshakeHeaders()).toMatchObject({
          "x-ultrapeer": "True",
          "x-ultrapeer-query-routing": "0.1",
          "x-dynamic-querying": "0.1",
          "x-ext-probes": "0.1",
          "x-degree": "16",
        });
        expect(
          node.connections.baseHandshakeHeaders()["x-ultrapeer-needed"],
        ).toBeUndefined();
      });
    });
  });

  test("learns a public advertised host from agreed Remote-IP reports", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        overrideRuntimeConfig(node, { advertisedHost: undefined });

        node.connections.absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "10.0.0.2",
        );
        expect(node.localAddress.learnedAdvertisedHost).toBeUndefined();

        node.connections.absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "23.1.2.3",
        );
        node.connections.absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "23.1.9.9",
        );
        expect(node.localAddress.learnedAdvertisedHost).toBeUndefined();

        node.connections.absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "24.2.3.4",
        );
        expect(node.localAddress.learnedAdvertisedHost).toBeUndefined();

        node.connections.absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "25.3.4.5",
        );
        expect(node.localAddress.learnedAdvertisedHost).toBe(
          "44.55.66.77",
        );
        expect(node.localAddress.currentAdvertisedHost()).toBe(
          "44.55.66.77",
        );

        node.discovery.addKnownPeer(
          "44.55.66.77",
          node.localAddress.currentAdvertisedPort(),
        );
        expect(node.getKnownPeers()).toEqual([]);

        const overrideNode = makeNode(path.join(dir, "override.json"));
        overrideRuntimeConfig(overrideNode, { advertisedHost: "7.7.7.7" });
        overrideNode.connections.absorbHandshakeHeaders(
          { "remote-ip": "88.99.77.66" },
          "26.4.5.6",
        );
        overrideNode.connections.absorbHandshakeHeaders(
          { "remote-ip": "88.99.77.66" },
          "27.5.6.7",
        );
        overrideNode.connections.absorbHandshakeHeaders(
          { "remote-ip": "88.99.77.66" },
          "28.6.7.8",
        );
        expect(
          overrideNode.localAddress.learnedAdvertisedHost,
        ).toBeUndefined();
        expect(overrideNode.localAddress.currentAdvertisedHost()).toBe(
          "7.7.7.7",
        );
      });
    });
  });

  test("rejects unexpected outbound handshake responses while absorbing X-Try peers", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const responses = [
          "GNUTELLA/0.6 503 Busy\r\nX-Try: 9.8.7.6:4321\r\n\r\n",
          "GNUTELLA OK\n\n",
        ];
        const node = makeNode(path.join(dir, "protocol.json"), {
          collaborators: {
            netFactory: {
              createConnection: (options: net.NetConnectOpts) => {
                const tcpOptions = options as net.NetConnectOpts & {
                  host?: string;
                  port?: number;
                };
                const socket = new MockSocket(
                  String(tcpOptions.host || "127.0.0.1"),
                  Number(tcpOptions.port || 0),
                );
                const response = responses.shift();
                if (!response)
                  throw new Error("expected mock handshake response");
                queueMicrotask(() => {
                  socket.emit("connect");
                  queueMicrotask(() => socket.emit("data", response));
                });
                return socket as unknown as net.Socket;
              },
            },
          },
        });
        const debugEvents: Array<{ phase: string; message: string }> = [];
        node.subscribe((event) => {
          if (event.type !== "HANDSHAKE_DEBUG") return;
          debugEvents.push({
            phase: event.phase,
            message: event.message,
          });
        });
        await expect(
          node.connections.connectPeer06("127.0.0.1", 6346),
        ).rejects.toThrow("0.6 handshake rejected by 127.0.0.1:6346");
        expect(node.getKnownPeers()).toContain("9.8.7.6:4321");

        await expect(
          node.connections.connectPeer06("127.0.0.1", 6347),
        ).rejects.toThrow(
          "unsupported 0.4 handshake response from 127.0.0.1:6347: GNUTELLA OK",
        );
        expect(debugEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              phase: "dial-start",
              message: "timeoutMs=5000",
            }),
            expect.objectContaining({
              phase: "connect-sent",
            }),
            expect.objectContaining({
              phase: "response-recv",
              message: expect.stringContaining("GNUTELLA/0.6 503 Busy"),
            }),
            expect.objectContaining({
              phase: "failed",
              message: expect.stringContaining(
                "0.6 handshake rejected by 127.0.0.1:6346",
              ),
            }),
          ]),
        );
      });
    });
  });

  test("routes and rejects inbound probe protocols", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const probeMessages: string[] = [];
      const httpHeads: Array<{ head: string; rest: string }> = [];
      const givHeads: string[] = [];
      node.subscribe((event) => {
        if (event.type === "PROBE_REJECTED") {
          probeMessages.push(event.message);
        }
      });
      node.transfers.startHttpSession = (
        _socket: net.Socket,
        head: string,
        rest = Buffer.alloc(0),
      ) => {
        httpHeads.push({ head, rest: rest.toString("latin1") });
      };
      node.transfers.handleIncomingGiv = async (
        _socket: net.Socket,
        head: string,
      ) => {
        givHeads.push(head);
        throw new Error("giv failed");
      };

      const httpSocket = new MockSocket();
      node.connections.handleProbe(httpSocket as never);
      httpSocket.emit(
        "data",
        "GET /uri-res/N2R?urn:sha1:TEST HTTP/1.1\r\nHost: example\r\n\r\nbody",
      );
      expect(httpHeads).toEqual([
        {
          head: "GET /uri-res/N2R?urn:sha1:TEST HTTP/1.1\r\nHost: example\r\n\r\n",
          rest: "body",
        },
      ]);

      const givSocket = new MockSocket();
      node.connections.handleProbe(givSocket as never);
      givSocket.emit("data", "GIV 0:1:alpha.txt\r\n\r\n");
      await Promise.resolve();
      await Promise.resolve();
      expect(givHeads).toEqual(["GIV 0:1:alpha.txt\r\n\r\n"]);
      expect(givSocket.destroyed).toBe(true);

      const legacySocket = new MockSocket();
      node.connections.handleProbe(legacySocket as never);
      legacySocket.emit(
        "data",
        "GNUTELLA CONNECT/0.4\r\nUser-Agent: OldPeer\r\n\r\n",
      );
      expect(legacySocket.destroyed).toBe(true);

      const unknownSocket = new MockSocket();
      node.connections.handleProbe(unknownSocket as never);
      unknownSocket.emit("data", "x".repeat(8203));
      expect(unknownSocket.destroyed).toBe(true);

      const leafRejectSocket = new MockSocket();
      node.connections.handleProbe(leafRejectSocket as never);
      leafRejectSocket.emit(
        "data",
        "GNUTELLA CONNECT/0.6\r\nUser-Agent: LeafPeer\r\nX-Ultrapeer: False\r\n\r\n",
      );
      const rejection = Buffer.concat(leafRejectSocket.writes).toString(
        "latin1",
      );
      expect(rejection).toContain("GNUTELLA/0.6 503 Shielded leaf node");
      expect(leafRejectSocket.ended).toBe(true);

      expect(probeMessages).toEqual([
        "unsupported inbound handshake: GNUTELLA CONNECT/0.4",
        "unknown inbound protocol",
      ]);
    });
  });

  test("serves HEAD /uri-res requests and rejects missing or malformed targets", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const share = makeShare(
        1,
        path.join(node.config().downloadsDir, "alpha.txt"),
        "alpha.txt",
      );
      await fs.mkdir(path.dirname(share.abs), { recursive: true });
      await fs.writeFile(share.abs, "hello", "utf8");
      node.shareLibrary.shares = [share];
      node.shareLibrary.sharesByIndex = new Map([[share.index, share]]);
      const shareUrn = share.sha1Urn;
      expect(shareUrn).toBeDefined();
      node.shareLibrary.sharesByUrn = new Map([
        [shareUrn!.toLowerCase(), share],
      ]);
      const shareBitprint = `urn:bitprint:${shareUrn!.slice("urn:sha1:".length)}.${"A".repeat(39)}`;

      const headSocket = new MockSocket();
      const headRequest = buildUriResRequest(shareBitprint, 2).replace(
        /^GET/,
        "HEAD",
      );
      await node.transfers.handleIncomingGet(
        headSocket as never,
        headRequest,
      );

      const headResponse = Buffer.concat(headSocket.writes).toString(
        "latin1",
      );
      expect(headSocket.ended).toBe(false);
      expect(headResponse).toContain("HTTP/1.1 206 Partial Content\r\n");
      expect(headResponse).toContain("Content-Length: 3\r\n");
      expect(headResponse).toContain("Connection: Keep-Alive\r\n");
      expect(headResponse).toContain(
        `X-Gnutella-Content-URN: ${shareUrn}\r\n`,
      );
      expect(headResponse).toContain(`X-Content-URN: ${shareUrn}\r\n`);
      expect(headResponse).not.toContain("hello");

      const rangedHeadSocket = new MockSocket();
      await node.transfers.handleIncomingGet(
        rangedHeadSocket as never,
        "HEAD /get/1/alpha.txt HTTP/1.1\r\nConnection: close\r\nRange: bytes=1-3\r\n\r\n",
      );

      const rangedHeadResponse = Buffer.concat(
        rangedHeadSocket.writes,
      ).toString("latin1");
      expect(rangedHeadSocket.ended).toBe(true);
      expect(rangedHeadResponse).toContain(
        "HTTP/1.1 206 Partial Content\r\n",
      );
      expect(rangedHeadResponse).toContain("Content-Length: 3\r\n");
      expect(rangedHeadResponse).toContain(
        "Content-Range: bytes 1-3/5\r\n",
      );
      expect(rangedHeadResponse).toContain("Connection: close\r\n");

      const missingSocket = new MockSocket();
      await node.transfers.handleIncomingGet(
        missingSocket as never,
        "GET /uri-res/N2R?urn:sha1:NOTFOUND HTTP/1.1\r\n\r\n",
      );
      expect(Buffer.concat(missingSocket.writes).toString("latin1")).toBe(
        "HTTP/1.0 404 Not Found\r\n\r\n",
      );

      const badSocket = new MockSocket();
      await node.transfers.handleIncomingGet(
        badSocket as never,
        "GET /not-a-download HTTP/1.1\r\n\r\n",
      );
      expect(Buffer.concat(badSocket.writes).toString("latin1")).toBe(
        "HTTP/1.0 400 Bad Request\r\n\r\n",
      );
    });
  });

  test("advertises browse-host support in query hits", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const share = makeShare(
        1,
        path.join(dir, "FW2PQUDZ.txt"),
        "FW2PQUDZ.txt",
      );
      node.shareLibrary.shares = [share];
      node.shareLibrary.sharesByIndex = new Map([[share.index, share]]);
      node.shareLibrary.sharesByUrn = new Map([
        [share.sha1Urn!.toLowerCase(), share],
      ]);
      const peer = makePeer();
      const sent: Array<{ payloadType: number; payload: Buffer }> = [];
      node.connections.sendToPeer = (
        _peer: unknown,
        payloadType: number,
        _descriptorId: Buffer,
        _ttl: number,
        _hops: number,
        payload: Buffer,
      ) => {
        sent.push({ payloadType, payload });
      };
      node.router.broadcastQuery = () => {};

      node.router.handleDescriptor(
        peer as never,
        makeHeader(TYPE.QUERY, 2, 0, 0x25),
        encodeQuery("FW2PQUDZ"),
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].payloadType).toBe(TYPE.QUERY_HIT);
      const qh = parseQueryHit(sent[0].payload);
      expect(parseGgep(qh.qhdPrivateArea || Buffer.alloc(0))).toEqual([
        { id: "BH", data: Buffer.alloc(0) },
      ]);
    });
  });

  test("serves browse-host query hits from GET / requests", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const alpha = makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt");
      const beta = makeShare(2, path.join(dir, "beta.bin"), "beta.bin");
      node.shareLibrary.shares = [alpha, beta];
      node.shareLibrary.sharesByIndex = new Map(
        node.shareLibrary.shares.map((share) => [share.index, share]),
      );
      node.shareLibrary.sharesByUrn = new Map(
        node.shareLibrary.shares.map((share) => [
          share.sha1Urn!.toLowerCase(),
          share,
        ]),
      );

      const socket = new MockSocket();
      await node.transfers.handleIncomingGet(
        socket as never,
        "GET / HTTP/1.1\r\nAccept: application/x-gnutella-packets\r\n\r\n",
      );

      const raw = Buffer.concat(socket.writes);
      const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"));
      expect(headerEnd).toBeGreaterThanOrEqual(0);
      const head = raw.subarray(0, headerEnd + 4).toString("latin1");
      expect(head).toContain("HTTP/1.1 200 OK\r\n");
      expect(head).toContain(
        "Content-Type: application/x-gnutella-packets\r\n",
      );
      expect(head).toContain("X-Features: browse/1.0\r\n");
      expect(head).toContain("Connection: close\r\n");
      expect(socket.ended).toBe(true);

      const packet = raw.subarray(headerEnd + 4);
      const descriptor = parseHeader(packet.subarray(0, 23));
      expect(descriptor.payloadType).toBe(TYPE.QUERY_HIT);
      const qh = parseQueryHit(
        packet.subarray(23, 23 + descriptor.payloadLength),
      );
      expect(qh.results.map((result) => result.fileName)).toEqual([
        "alpha.txt",
        "beta.bin",
      ]);
    });
  });
});
