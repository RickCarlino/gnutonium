import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { TYPE } from "../../../src/const";
import {
  buildHeader,
  defaultDoc,
  encodeBye,
  encodeQuery,
  parseBye,
  parseHeader,
  parseRouteTableUpdate,
  QrpTable,
} from "../../../src/protocol";
import { sleep } from "../../../src/shared";
import {
  makeHeader,
  makeNode,
  makePeer,
  makeShare,
  MockSocket,
  overrideRuntimeConfig,
  withMockNetworkInterfaces,
  withTempDir,
} from "../../helpers/protocol";
import { TestServent as GnutellaServent } from "../../helpers/servent";

describe("protocol node", () => {
  test("start schedules recurring work and reports maintenance failures", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const configPath = path.join(dir, "protocol.json");
        const doc = defaultDoc(configPath);
        doc.config.listenHost = "127.0.0.1";
        const events: Array<{
          type: string;
          operation?: string;
          message?: string;
        }> = [];
        const node = new GnutellaServent(configPath, doc, {
          onEvent: (event) =>
            events.push(event as unknown as (typeof events)[number]),
        });
        const scheduled: Array<{ ms: number; fn: () => void }> = [];
        const pingTtls: number[] = [];
        let refreshCalls = 0;
        let reconnectCalls = 0;
        let saveCalls = 0;
        let startServerCalls = 0;
        let pruneCalls = 0;

        node.refreshShares = async () => {
          refreshCalls += 1;
          if (refreshCalls > 1) throw new Error("rescan failed");
        };
        node.connections.startServer = async () => {
          startServerCalls += 1;
        };
        node.schedule = (ms: number, fn: () => void) => {
          scheduled.push({ ms, fn });
        };
        node.discovery.connectKnownPeers = async () => {
          reconnectCalls += 1;
          throw new Error(
            reconnectCalls === 1
              ? "initial reconnect failed"
              : "scheduled reconnect failed",
          );
        };
        node.sendPing = (ttl: number) => {
          pingTtls.push(ttl);
        };
        node.pruneMaps = () => {
          pruneCalls += 1;
        };
        node.save = async () => {
          saveCalls += 1;
          throw new Error("save failed");
        };

        await node.start();
        await Promise.resolve();

        expect(startServerCalls).toBe(1);
        expect(refreshCalls).toBe(1);
        expect(scheduled.map((entry) => entry.ms)).toEqual([
          node.config().rescanSharesSec * 1000,
          5000,
          node.config().reconnectIntervalSec * 1000,
          node.config().pingIntervalSec * 1000,
          15000,
        ]);

        for (const entry of scheduled) entry.fn();
        await Promise.resolve();

        expect(refreshCalls).toBe(2);
        expect(reconnectCalls).toBe(2);
        expect(pruneCalls).toBe(1);
        expect(saveCalls).toBe(1);
        expect(pingTtls).toEqual([node.config().defaultPingTtl]);

        const maintenance = events.filter(
          (event) => event.type === "MAINTENANCE_ERROR",
        );
        expect(maintenance).toEqual([
          expect.objectContaining({
            operation: "RECONNECT",
            message: "initial reconnect failed",
          }),
          expect.objectContaining({
            operation: "SHARE_RESCAN",
            message: "rescan failed",
          }),
          expect.objectContaining({
            operation: "RECONNECT",
            message: "scheduled reconnect failed",
          }),
          expect.objectContaining({
            operation: "SAVE",
            message: "save failed",
          }),
        ]);
      });
    });
  });

  test("emits inbound peer message events for received descriptors", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const configPath = path.join(dir, "protocol.json");
        const doc = defaultDoc(configPath);
        const events: Array<Record<string, unknown>> = [];
        const node = new GnutellaServent(configPath, doc, {
          onEvent: (event) =>
            events.push(event as unknown as Record<string, unknown>),
        });
        const peer = makePeer("9.8.7.6:4321");
        const payload = Buffer.alloc(0);
        const frame = buildHeader(
          Buffer.alloc(16, 0xaa),
          TYPE.PING,
          9,
          2,
          payload,
        );

        peer.buf = Buffer.concat([frame, payload]);
        node.connections.consumePeerBuffer(peer);

        expect(events).toContainEqual(
          expect.objectContaining({
            type: "PEER_MESSAGE_RECEIVED",
            peer: expect.objectContaining({
              key: "9.8.7.6:4321",
              remoteLabel: "9.8.7.6:4321",
              outbound: false,
              compression: false,
              tls: false,
            }),
            payloadType: TYPE.PING,
            payloadTypeName: "PING",
            descriptorIdHex: "aa".repeat(16),
            ttl: node.config().maxTtl,
            hops: 2,
            payloadLength: 0,
          }),
        );
      });
    });
  });

  test("emits outbound peer message events for sent descriptors", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const configPath = path.join(dir, "protocol.json");
        const doc = defaultDoc(configPath);
        const events: Array<Record<string, unknown>> = [];
        const node = new GnutellaServent(configPath, doc, {
          onEvent: (event) =>
            events.push(event as unknown as Record<string, unknown>),
        });
        const peer = makePeer("9.8.7.6:4321");

        node.connections.sendToPeer(
          peer,
          TYPE.PING,
          Buffer.alloc(16, 0xbb),
          3,
          1,
          Buffer.alloc(0),
        );

        expect(events).toEqual([
          expect.objectContaining({
            type: "PEER_MESSAGE_SENT",
            peer: expect.objectContaining({
              key: "9.8.7.6:4321",
              remoteLabel: "9.8.7.6:4321",
              outbound: false,
              compression: false,
              tls: false,
            }),
            payloadType: TYPE.PING,
            payloadTypeName: "PING",
            descriptorIdHex: "bb".repeat(16),
            ttl: 3,
            hops: 1,
            payloadLength: 0,
          }),
        ]);
      });
    });
  });

  test("rejects descriptors relayed by leaf peers", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const peer = makePeer("leaf-relay");
      const payload = Buffer.alloc(0);
      peer.buf = buildHeader(
        Buffer.alloc(16, 0xcc),
        TYPE.PING,
        1,
        1,
        payload,
      );

      node.connections.consumePeerBuffer(peer);

      const socket = peer.socket as unknown as MockSocket;
      expect(socket.writes).toHaveLength(1);
      const header = parseHeader(socket.writes[0]!.subarray(0, 23));
      expect(header.payloadType).toBe(TYPE.BYE);
      expect(header.ttl).toBe(1);
      expect(header.hops).toBe(0);
      const bye = parseBye(socket.writes[0]!.subarray(23));
      expect(bye.code).toBe(414);
      expect(bye.message).toContain("Leaf node relayed PING");
    });
  });

  test("prunes stale routes, pending pushes, and cached pongs", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      overrideRuntimeConfig(node, {
        seenTtlSec: 1,
        routeTtlSec: 1,
        pushWaitMs: 1_000,
      });
      const now = Date.now();
      const rejected: string[] = [];

      node.router.seen.set("stale-seen", now - 2_000);
      node.router.seen.set("fresh-seen", now);
      node.router.pingRoutes.set("stale-ping", {
        peerKey: "p1",
        ts: now - 2_000,
      } as never);
      node.router.pingRoutes.set("local-ping", "__local__" as never);
      node.router.queryRoutes.set("stale-query", {
        peerKey: "p1",
        ts: now - 2_000,
      } as never);
      node.router.queryRoutes.set("local-query", "__local__" as never);
      node.router.pushRoutes.set("stale-push", {
        peerKey: "p1",
        ts: now - 2_000,
      } as never);
      node.transfers.pendingPushes.set("servent-1", [
        {
          serventIdHex: "servent-1",
          result: { fileIndex: 1 } as never,
          destPath: path.join(dir, "downloads", "stale.bin"),
          createdAt: now - 2_000,
          resolve: () => void 0,
          reject: (error) =>
            rejected.push(
              error instanceof Error ? error.message : String(error),
            ),
        },
        {
          serventIdHex: "servent-1",
          result: { fileIndex: 2 } as never,
          destPath: path.join(dir, "downloads", "fresh.bin"),
          createdAt: now,
          resolve: () => void 0,
          reject: () => void 0,
        },
      ]);
      node.router.pongCache.set("stale-pong", {
        payload: Buffer.from("stale", "utf8"),
        at: now - 2_000,
      });
      node.router.pongCache.set("fresh-pong", {
        payload: Buffer.from("fresh", "utf8"),
        at: now,
      });

      node.pruneMaps();

      expect(node.router.seen.has("stale-seen")).toBe(false);
      expect(node.router.seen.has("fresh-seen")).toBe(true);
      expect(node.router.pingRoutes.has("stale-ping")).toBe(false);
      expect(node.router.pingRoutes.get("local-ping")).toBe("__local__");
      expect(node.router.queryRoutes.has("stale-query")).toBe(false);
      expect(node.router.queryRoutes.get("local-query")).toBe("__local__");
      expect(node.router.pushRoutes.has("stale-push")).toBe(false);
      expect(rejected).toEqual(["push timed out"]);
      expect(node.transfers.pendingPushes.get("servent-1")).toHaveLength(
        1,
      );
      expect(node.router.pongCache.has("stale-pong")).toBe(false);
      expect(node.router.pongCache.has("fresh-pong")).toBe(true);
    });
  });

  test("applies route-table updates and only sends QRP tables when negotiated", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      doc.config.dataDir = dir;
      const node = new GnutellaServent(configPath, doc);
      const share = makeShare(
        1,
        path.join(node.config().downloadsDir, "alpha-track.txt"),
        "alpha-track.txt",
      );
      node.router.qrpTable.rebuildFromShares([share]);

      const peer = makePeer("peer-qrp");
      const sent: Buffer[] = [];
      node.connections.sendToPeer = (
        _peer: unknown,
        payloadType: number,
        _descriptorId: Buffer,
        _ttl: number,
        _hops: number,
        payload: Buffer,
      ) => {
        expect(payloadType).toBe(TYPE.ROUTE_TABLE_UPDATE);
        sent.push(Buffer.from(payload));
      };

      await node.router.sendQrpTable(peer as never);
      expect(sent).toHaveLength(0);

      peer.capabilities.queryRoutingVersion = "0.1";
      overrideRuntimeConfig(node, { enableQrp: false });
      await node.router.sendQrpTable(peer as never);
      expect(sent).toHaveLength(0);

      overrideRuntimeConfig(node, { enableQrp: true });
      await node.router.sendQrpTable(peer as never);
      expect(sent.length).toBeGreaterThan(1);
      expect(parseRouteTableUpdate(sent[0])?.variant).toBe("reset");
      for (const payload of sent.slice(1)) {
        expect(parseRouteTableUpdate(payload).variant).toBe("patch");
      }

      const remote = makePeer("remote-qrp");
      node.router.onRouteTableUpdate(remote as never, sent[0]);
      for (const payload of sent.slice(1))
        node.router.onRouteTableUpdate(remote as never, payload);
      expect(node.router.peerState(remote).qrp.resetSeen).toBe(true);
      expect(node.router.peerState(remote).qrp.table).not.toBeNull();
    });
  });

  test("rejects QRP updates that violate gtk-gnutella validation rules", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));

      const qrpReset = Buffer.alloc(6);
      qrpReset[0] = 0x00;
      qrpReset.writeUInt32LE(8, 1);
      qrpReset[5] = 1;

      const qrpPatch = (seqNo: number, seqSize: number) =>
        Buffer.from([0x01, seqNo, seqSize, 0x00, 0x01, 0x80]);

      const sentBye = (peer: ReturnType<typeof makePeer>) => {
        const socket = peer.socket as unknown as MockSocket;
        expect(socket.writes).toHaveLength(1);
        const frame = socket.writes[0]!;
        const header = parseHeader(frame.subarray(0, 23));
        expect(header.payloadType).toBe(TYPE.BYE);
        expect(header.ttl).toBe(1);
        expect(header.hops).toBe(0);
        return parseBye(frame.subarray(23));
      };

      const patchBeforeReset = makePeer("patch-before-reset");
      node.router.onRouteTableUpdate(
        patchBeforeReset as never,
        qrpPatch(1, 1),
      );
      expect(sentBye(patchBeforeReset).code).toBe(413);

      const invalidLengthReset = makePeer("invalid-length-reset");
      node.router.onRouteTableUpdate(
        invalidLengthReset as never,
        Buffer.from([0x00, 12, 0, 0, 0, 1]),
      );
      expect(sentBye(invalidLengthReset).message).toContain(
        "Invalid QRP table length 12",
      );
      expect(node.router.peerState(invalidLengthReset).qrp.resetSeen).toBe(
        false,
      );

      const invalidInfinityReset = makePeer("invalid-infinity-reset");
      node.router.onRouteTableUpdate(
        invalidInfinityReset as never,
        Buffer.from([0x00, 8, 0, 0, 0, 0]),
      );
      expect(sentBye(invalidInfinityReset).message).toContain(
        "Invalid QRP infinity 0",
      );
      expect(
        node.router.peerState(invalidInfinityReset).qrp.resetSeen,
      ).toBe(false);

      const skippedSequence = makePeer("skipped-sequence");
      node.router.onRouteTableUpdate(skippedSequence as never, qrpReset);
      node.router.onRouteTableUpdate(
        skippedSequence as never,
        qrpPatch(2, 2),
      );
      expect(sentBye(skippedSequence).message).toContain(
        "Invalid QRP seq number 2",
      );

      const changedSeqSize = makePeer("changed-seq-size");
      node.router.onRouteTableUpdate(changedSeqSize as never, qrpReset);
      node.router.onRouteTableUpdate(
        changedSeqSize as never,
        qrpPatch(1, 2),
      );
      expect(
        (changedSeqSize.socket as unknown as MockSocket).writes,
      ).toHaveLength(0);
      node.router.onRouteTableUpdate(
        changedSeqSize as never,
        qrpPatch(2, 3),
      );
      expect(sentBye(changedSeqSize).message).toContain(
        "Changed QRP seq size",
      );

      const incompletePatch = makePeer("incomplete-patch");
      const qrpReset16 = Buffer.alloc(6);
      qrpReset16[0] = 0x00;
      qrpReset16.writeUInt32LE(16, 1);
      qrpReset16[5] = 1;
      node.router.onRouteTableUpdate(incompletePatch as never, qrpReset16);
      node.router.onRouteTableUpdate(
        incompletePatch as never,
        Buffer.from([0x01, 1, 1, 0x00, 0x01, 0xff]),
      );
      expect(sentBye(incompletePatch).message).toContain(
        "Incomplete 1-bit QRP patch covered 8/16 slots",
      );
      expect(node.router.peerState(incompletePatch).qrp.table).toBeNull();
    });
  });

  test("publishes aggregate ultrapeer QRP to mesh peers and skips leaf peers", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      doc.config.dataDir = dir;
      doc.config.ultrapeer = true;
      const node = new GnutellaServent(configPath, doc);
      overrideRuntimeConfig(node, {
        ultrapeer: true,
        nodeMode: "ultrapeer",
        enableQrp: true,
      });

      const ownShare = makeShare(
        1,
        path.join(node.config().downloadsDir, "own-alpha.txt"),
        "own-alpha.txt",
      );
      node.router.qrpTable.rebuildFromShares([ownShare]);

      const leaf = makePeer("leaf-peer");
      leaf.role = "leaf";
      const leafTable = new QrpTable();
      leafTable.rebuildFromShares([
        makeShare(
          2,
          path.join(node.config().downloadsDir, "leaf-zeta.txt"),
          "leaf-zeta.txt",
        ),
      ]);
      node.router.peerState(leaf).qrp = {
        resetSeen: true,
        tableSize: leafTable.tableSize,
        infinity: leafTable.infinity,
        entryBits: leafTable.entryBits,
        table: leafTable.table.slice(),
        seqSize: 0,
        compressor: 0,
        parts: new Map<number, Buffer>(),
      };
      node.connections.peers.set(leaf.key, leaf);

      const meshPeer = makePeer("mesh-peer");
      meshPeer.role = "ultrapeer";
      meshPeer.capabilities.isUltrapeer = true;
      meshPeer.capabilities.ultrapeerQueryRoutingVersion = "0.1";

      const sent: Buffer[] = [];
      node.connections.sendToPeer = (
        _peer: unknown,
        payloadType: number,
        _descriptorId: Buffer,
        _ttl: number,
        _hops: number,
        payload: Buffer,
      ) => {
        expect(payloadType).toBe(TYPE.ROUTE_TABLE_UPDATE);
        sent.push(Buffer.from(payload));
      };

      await node.router.sendQrpTable(leaf as never);
      expect(sent).toHaveLength(0);

      await node.router.sendQrpTable(meshPeer as never);
      expect(sent.length).toBeGreaterThan(1);

      const remote = makePeer("remote-mesh");
      remote.role = "ultrapeer";
      node.router.onRouteTableUpdate(remote as never, sent[0]);
      for (const payload of sent.slice(1))
        node.router.onRouteTableUpdate(remote as never, payload);

      expect(node.router.peerState(remote).qrp.table).not.toBeNull();
      expect(
        QrpTable.matchesRemote(
          node.router.peerState(remote).qrp,
          "own alpha",
        ),
      ).toBe(true);
      expect(
        QrpTable.matchesRemote(
          node.router.peerState(remote).qrp,
          "leaf zeta",
        ),
      ).toBe(true);
    });
  });

  test("does not forward leaf-routed queries before the leaf QRT arrives", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      overrideRuntimeConfig(node, {
        ultrapeer: true,
        nodeMode: "ultrapeer",
        enableQrp: true,
      });

      const source = makePeer("source-ultrapeer");
      source.role = "ultrapeer";
      const leaf = makePeer("leaf-without-qrt");
      leaf.role = "leaf";
      node.connections.peers.set(source.key, source);
      node.connections.peers.set(leaf.key, leaf);

      const sent: Array<{ peerKey: string; payloadType: number }> = [];
      node.connections.sendToPeer = (
        peerArg: unknown,
        payloadType: number,
        _descriptorId: Buffer,
        _ttl: number,
        _hops: number,
        _payload: Buffer,
      ) => {
        sent.push({
          peerKey: (peerArg as ReturnType<typeof makePeer>).key,
          payloadType,
        });
      };

      node.router.onQueryDescriptor(
        source as never,
        makeHeader(TYPE.QUERY, 1, 0, 1),
        encodeQuery("alpha"),
      );
      expect(sent).toEqual([]);

      const table = new QrpTable();
      table.rebuildFromShares([
        makeShare(
          1,
          path.join(node.config().downloadsDir, "alpha.txt"),
          "alpha.txt",
        ),
      ]);
      node.router.peerState(leaf).qrp = {
        resetSeen: true,
        tableSize: table.tableSize,
        infinity: table.infinity,
        entryBits: table.entryBits,
        table: table.table.slice(),
        seqSize: 0,
        compressor: 0,
        parts: new Map<number, Buffer>(),
      };

      node.router.onQueryDescriptor(
        source as never,
        makeHeader(TYPE.QUERY, 1, 0, 2),
        encodeQuery("alpha"),
      );
      expect(sent).toEqual([
        { peerKey: leaf.key, payloadType: TYPE.QUERY },
      ]);
    });
  });

  test("closes sockets on Bye even when the payload is malformed", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));

      const validPeer = makePeer("valid-bye");
      node.router.onBye(validPeer as never, encodeBye(200, "closing"));
      expect((validPeer.socket as unknown as MockSocket).ended).toBe(true);

      const malformedPeer = makePeer("bad-bye");
      expect(() =>
        node.router.onBye(malformedPeer as never, Buffer.from([0x00])),
      ).not.toThrow();
      expect(
        (malformedPeer.socket as unknown as { ended: boolean }).ended,
      ).toBe(true);
    });
  });

  test("processes successive keep-alive HEAD requests on one HTTP socket", async () => {
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

      const socket = new MockSocket();
      node.transfers.startHttpSession(
        socket as never,
        "HEAD /get/1/alpha.txt HTTP/1.1\r\n\r\n",
      );

      await sleep(5);
      socket.emit(
        "data",
        Buffer.from(
          `HEAD /uri-res/N2R?${shareUrn} HTTP/1.1\r\nConnection: close\r\n\r\n`,
          "latin1",
        ),
      );

      await sleep(25);

      const raw = Buffer.concat(socket.writes).toString("latin1");
      expect(raw.match(/HTTP\/1\.1 200 OK/g)?.length).toBe(2);
      expect(raw).toContain("Connection: Keep-Alive\r\n");
      expect(raw).toContain("Connection: close\r\n");
      expect(socket.ended).toBe(true);
    });
  });
});
