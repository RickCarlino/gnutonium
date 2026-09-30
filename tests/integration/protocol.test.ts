import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { TYPE } from "../../src/const";
import { defaultDoc, loadDoc, writeDoc } from "../../src/protocol";
import { QrpTable } from "../../src/routing/qrp";
import { sleep } from "../../src/shared";
import type { GnutellaEvent, RuntimeConfig } from "../../src/types";
import { withFakeNet } from "../helpers/fake_net";
import { TestServent as GnutellaServent } from "../helpers/servent";

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "protocol-integration-"),
  );
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate an ephemeral port"));
        return;
      }
      const { port } = addr;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 3_000,
  describeState?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  const suffix = describeState ? ` (${describeState()})` : "";
  throw new Error(`timed out waiting for ${description}${suffix}`);
}

async function readSocketResponse(
  port: number,
  request: string,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let done = false;
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(error);
    };
    socket.on("error", fail);
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("latin1"));
    });
  });
}

type MeshNodeName = "A" | "B" | "C";

type MeshNode = {
  name: MeshNodeName;
  configPath: string;
  downloadsDir: string;
  listenPort: number;
  advertisedPort: number;
  node: GnutellaServent;
  events: GnutellaEvent[];
};

type Mesh = {
  nodes: Record<MeshNodeName, MeshNode>;
  badPort: number;
};

async function writeShare(
  node: MeshNode,
  rel: string,
  contents: string,
): Promise<void> {
  const abs = path.join(node.downloadsDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}

function eventsOfType<T extends GnutellaEvent["type"]>(
  node: MeshNode,
  type: T,
): Extract<GnutellaEvent, { type: T }>[] {
  return node.events.filter(
    (event): event is Extract<GnutellaEvent, { type: T }> =>
      event.type === type,
  );
}

function newResults(node: MeshNode, searchId: string) {
  return node.node.getResults(searchId);
}

function overrideRuntimeConfig(
  node: GnutellaServent,
  patch: Partial<RuntimeConfig>,
): void {
  node.updateRuntimeConfig(patch);
}

function peerState(
  entries: Array<[string, number]>,
): Record<string, number> {
  return Object.fromEntries(entries);
}

async function createMeshNode(
  root: string,
  name: MeshNodeName,
  options: {
    listenPort: number;
    advertisedPort: number;
    advertisedSpeedKBps: number;
    peers: string[];
    shares: Record<string, string>;
    ultrapeer?: boolean;
    enableQrp?: boolean;
    maxConnections?: number;
    maxLeafConnections?: number;
  },
): Promise<MeshNode> {
  const dir = path.join(root, name.toLowerCase());
  const configPath = path.join(dir, "protocol.json");
  const downloadsDir = path.join(dir, "downloads");

  await fs.mkdir(downloadsDir, { recursive: true });
  for (const [rel, contents] of Object.entries(options.shares)) {
    const abs = path.join(downloadsDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, "utf8");
  }

  const doc = defaultDoc(configPath);
  const nowSec = Math.floor(Date.now() / 1000);
  doc.config.listenHost = "127.0.0.1";
  doc.config.listenPort = options.listenPort;
  doc.config.advertisedHost = "127.0.0.1";
  doc.config.advertisedPort = options.advertisedPort;
  doc.config.dataDir = dir;
  doc.config.ultrapeer = options.ultrapeer ?? true;
  doc.state.peers = peerState(options.peers.map((peer) => [peer, nowSec]));

  await writeDoc(configPath, doc);
  const loaded = await loadDoc(configPath);
  const events: GnutellaEvent[] = [];
  const node = new GnutellaServent(configPath, loaded, {
    onEvent: (event) => events.push(event),
  });
  overrideRuntimeConfig(node, {
    maxConnections: options.maxConnections ?? 4,
    maxLeafConnections: options.maxLeafConnections ?? 4,
    connectTimeoutMs: 1_000,
    pingIntervalSec: 3_600,
    reconnectIntervalSec: 3_600,
    rescanSharesSec: 3_600,
    routeTtlSec: 60,
    seenTtlSec: 60,
    defaultPingTtl: 2,
    defaultQueryTtl: 2,
    downloadTimeoutMs: 1_500,
    pushWaitMs: 1_500,
    maxResultsPerQuery: 10,
    advertisedSpeedKBps: options.advertisedSpeedKBps,
    enableCompression: false,
    enableQrp: options.enableQrp ?? false,
    enableBye: true,
    enablePongCaching: true,
    enableGgep: true,
  });

  return {
    name,
    configPath,
    downloadsDir,
    listenPort: options.listenPort,
    advertisedPort: options.advertisedPort,
    node,
    events,
  };
}

async function createMesh(root: string): Promise<Mesh> {
  const [aPort, bPort, cPort, badPort] = await Promise.all([
    getFreePort(),
    getFreePort(),
    getFreePort(),
    getFreePort(),
  ]);

  const nodes: Record<MeshNodeName, MeshNode> = {
    A: await createMeshNode(root, "A", {
      listenPort: aPort,
      advertisedPort: aPort,
      advertisedSpeedKBps: 256,
      peers: [`127.0.0.1:${bPort}`],
      shares: {
        "a-local.txt": "shared by A",
      },
    }),
    B: await createMeshNode(root, "B", {
      listenPort: bPort,
      advertisedPort: bPort,
      advertisedSpeedKBps: 128,
      peers: [],
      shares: {
        "mesh-common-b.txt": "common from B",
        "resume-b.bin": "resume-from-b",
      },
    }),
    C: await createMeshNode(root, "C", {
      listenPort: cPort,
      advertisedPort: badPort,
      advertisedSpeedKBps: 768,
      peers: [`127.0.0.1:${bPort}`],
      shares: {
        "mesh-common-c.txt": "common from C",
        "push-only-c.bin": "push-from-c",
      },
    }),
  };

  return { nodes, badPort };
}

async function withMesh<T>(fn: (mesh: Mesh) => Promise<T>): Promise<T> {
  return await withTempDir(async (root) => {
    const mesh = await createMesh(root);
    const { A, B, C } = mesh.nodes;
    try {
      await B.node.start();
      await A.node.start();
      await C.node.start();

      await waitFor(
        () =>
          A.node.connections.peerCount() === 1 &&
          B.node.connections.peerCount() === 2 &&
          C.node.connections.peerCount() === 1,
        "A-B-C 0.6 mesh to come online",
      );

      await sleep(700);
      return await fn(mesh);
    } finally {
      await Promise.allSettled([
        A.node.stop(),
        B.node.stop(),
        C.node.stop(),
      ]);
    }
  });
}

async function withFakeMesh<T>(
  fn: (mesh: Mesh) => Promise<T>,
): Promise<T> {
  return await withFakeNet(async () => await withMesh(fn));
}

describe("Integration suite (0.6)", () => {
  test("keeps parallel queries and browse results separate across the mesh", async () => {
    await withFakeMesh(async ({ nodes: { A, B, C } }) => {
      await writeShare(B, "parallel-alpha.txt", "alpha");
      await writeShare(C, "parallel-beta.txt", "beta");
      await B.node.refreshShares();
      await C.node.refreshShares();
      const a = A.node.sendQuery("parallel-alpha", 2)!;
      const b = A.node.sendQuery("parallel-beta", 2)!;
      await waitFor(
        () =>
          A.node.getResults(a.id).length > 0 &&
          A.node.getResults(b.id).length > 0,
        "both independent queries to receive hits",
      );
      expect(A.node.getResults(a.id).map((hit) => hit.fileName)).toEqual([
        "parallel-alpha.txt",
      ]);
      expect(A.node.getResults(b.id).map((hit) => hit.fileName)).toEqual([
        "parallel-beta.txt",
      ]);
      const browse = await A.node.browsePeer(`127.0.0.1:${B.listenPort}`);
      expect(browse.kind).toBe("browse");
      expect(
        A.node
          .getResults(browse.id)
          .some((hit) => hit.fileName === "parallel-alpha.txt"),
      ).toBe(true);
      A.node.clearResults(a.id);
      expect(() => A.node.getResults(a.id)).toThrow("no such search");
      expect(A.node.getResults(b.id)).toHaveLength(1);
      expect(A.node.router.queryRoutes.has(a.id)).toBe(false);
      expect(A.node.router.queryRoutes.has(b.id)).toBe(true);
      expect(A.node.getSearches().map((entry) => entry.id)).toEqual([
        b.id,
        browse.id,
      ]);
      const again = A.node.sendQuery("parallel-alpha", 2)!;
      await waitFor(
        () => A.node.getResults(again.id).length > 0,
        "a fresh search after clearing",
      );
      expect(A.node.getResults(b.id)).toHaveLength(1);
      expect(A.node.getResults(again.id)[0]!.resultNo).toBeGreaterThan(
        A.node.getResults(b.id)[0]!.resultNo,
      );
    });
  });

  test("connects peers added while already running", async () => {
    await withFakeNet(async () => {
      await withTempDir(async (root) => {
        const [aPort, bPort] = await Promise.all([
          getFreePort(),
          getFreePort(),
        ]);
        const a = await createMeshNode(root, "A", {
          listenPort: aPort,
          advertisedPort: aPort,
          advertisedSpeedKBps: 256,
          peers: [],
          shares: {},
        });
        const b = await createMeshNode(root, "B", {
          listenPort: bPort,
          advertisedPort: bPort,
          advertisedSpeedKBps: 128,
          peers: [],
          shares: {
            "live-connect.txt": "connected at runtime",
          },
        });

        try {
          await b.node.start();
          await a.node.start();
          expect(a.node.connections.peerCount()).toBe(0);

          await expect(
            a.node.connectToPeer(`127.0.0.1:${bPort}`),
          ).resolves.toEqual({
            peer: `127.0.0.1:${bPort}`,
            status: "connected",
          });

          await waitFor(
            () =>
              a.node.connections.peerCount() === 1 &&
              b.node.connections.peerCount() === 1,
            "runtime 0.6 peer connection to come online",
          );

          const before = a.node.sendQuery("live-connect", 1)!.id;
          await waitFor(
            () =>
              newResults(a, before).some(
                (hit) => hit.fileName === "live-connect.txt",
              ),
            "runtime-connected 0.6 peer to answer a query",
          );
        } finally {
          await Promise.allSettled([a.node.stop(), b.node.stop()]);
        }
      });
    });
  });

  test("routes ping/pong, refresh, and query traffic across A -> B -> C", async () => {
    await withFakeMesh(async ({ nodes }) => {
      const { A, B, C } = nodes;
      const peerToB = A.node.getPeers()[0];

      expect(peerToB?.dialTarget).toBe(`127.0.0.1:${B.listenPort}`);
      expect(C.node.getPeers()[0]?.dialTarget).toBe(
        `127.0.0.1:${B.listenPort}`,
      );
      expect(B.node.getPeers()).toHaveLength(2);

      const pongsBefore = eventsOfType(A, "PONG").length;
      A.node.sendPing(2);
      const pingId =
        eventsOfType(A, "PING_SENT").at(-1)?.descriptorIdHex || "";
      await waitFor(
        () => eventsOfType(A, "PONG").length >= pongsBefore + 2,
        "A to receive 0.6 pongs from both B and C",
        3_000,
        () =>
          JSON.stringify({
            pingId,
            pongsBefore,
            pongEvents: eventsOfType(A, "PONG"),
            knownPeers: A.node.getKnownPeers(),
            bKnownPeers: B.node.getKnownPeers(),
            cKnownPeers: C.node.getKnownPeers(),
            aSeenPong: A.node.router.seen.has(`1:${pingId}`),
            bPingRoute: B.node.router.pingRoutes.get(pingId),
            bSeenPong: B.node.router.seen.has(`1:${pingId}`),
            cSeenPing: C.node.router.seen.has(`0:${pingId}`),
            cSeenPong: C.node.router.seen.has(`1:${pingId}`),
            aPeers: A.node.getPeers(),
            bPeers: B.node.getPeers(),
            cPeers: C.node.getPeers(),
          }),
      );

      expect(A.node.getKnownPeers()).toEqual(
        expect.arrayContaining([
          `127.0.0.1:${B.listenPort}`,
          `127.0.0.1:${C.advertisedPort}`,
        ]),
      );

      await writeShare(C, "late-route-c.txt", "late route from C");
      await C.node.refreshShares();
      expect(
        C.node
          .getShares()
          .some((share) => share.name === "late-route-c.txt"),
      ).toBe(true);

      const routedBefore = A.node.sendQuery("late-route-c", 2)!.id;
      await waitFor(
        () =>
          newResults(A, routedBefore).some(
            (hit) => hit.fileName === "late-route-c.txt",
          ),
        "A to receive 0.6 C query hit through B",
      );

      const routedHit = newResults(A, routedBefore).find(
        (hit) => hit.fileName === "late-route-c.txt",
      );
      expect(routedHit).toEqual(
        expect.objectContaining({
          fileName: "late-route-c.txt",
          vendorCode: "NIUM",
          remoteHost: "127.0.0.1",
          remotePort: C.advertisedPort,
          queryHops: 1,
          viaPeerKey: peerToB.key,
        }),
      );

      const filteredBefore = A.node.sendQuery("mesh-common", 2)!.id;
      await waitFor(() => {
        const hits = newResults(A, filteredBefore)
          .filter((hit) => hit.fileName.includes("mesh-common"))
          .map((hit) => hit.fileName)
          .sort();
        return (
          hits.length === 2 &&
          hits[0] === "mesh-common-b.txt" &&
          hits[1] === "mesh-common-c.txt"
        );
      }, "A to receive modern query hits from both B and C");
      await sleep(200);

      const filtered = newResults(A, filteredBefore).filter((hit) =>
        hit.fileName.includes("mesh-common"),
      );
      expect(filtered).toHaveLength(2);
      expect(filtered.map((hit) => hit.fileName).sort()).toEqual([
        "mesh-common-b.txt",
        "mesh-common-c.txt",
      ]);
      expect(filtered).toContainEqual(
        expect.objectContaining({
          fileName: "mesh-common-b.txt",
          remotePort: B.advertisedPort,
          queryHops: 0,
          viaPeerKey: peerToB.key,
        }),
      );
      expect(filtered).toContainEqual(
        expect.objectContaining({
          fileName: "mesh-common-c.txt",
          remotePort: C.advertisedPort,
          queryHops: 1,
          viaPeerKey: peerToB.key,
        }),
      );
    });
  });

  test("covers range downloads, direct resume, push fallback, and persisted state", async () => {
    await withFakeMesh(async ({ nodes, badPort }) => {
      const { A, B, C } = nodes;

      const pingCount = eventsOfType(A, "PONG").length;
      A.node.sendPing(2);
      await waitFor(
        () => eventsOfType(A, "PONG").length >= pingCount + 2,
        "A to refresh discovered peers before saving 0.6 state",
        3_000,
        () =>
          JSON.stringify({
            pingCount,
            pongEvents: eventsOfType(A, "PONG"),
            knownPeers: A.node.getKnownPeers(),
          }),
      );

      const resumeShare = B.node
        .getShares()
        .find((share) => share.name === "resume-b.bin");
      expect(resumeShare).toBeDefined();

      const ranged = await readSocketResponse(
        B.listenPort,
        `GET /get/${resumeShare!.index}/${resumeShare!.name}/ HTTP/1.0\r\nConnection: close\r\nRange: bytes=7-\r\n\r\n`,
      );
      expect(ranged).toContain("HTTP/1.0 206 Partial Content\r\n");
      expect(ranged).toContain("Server: Gnutonium/2.0.0\r\n");
      expect(ranged).toContain("Content-Length: 6\r\n");
      expect(ranged).toContain("Content-Range: bytes 7-12/13\r\n");
      expect(ranged.endsWith("from-b")).toBe(true);

      const directBefore = A.node.sendQuery("resume-b", 2)!.id;
      await waitFor(
        () =>
          newResults(A, directBefore).some(
            (hit) => hit.fileName === "resume-b.bin",
          ),
        "A to receive a 0.6 direct-download result from B",
      );

      const directHit = newResults(A, directBefore).find(
        (hit) => hit.fileName === "resume-b.bin",
      );
      expect(directHit).toBeDefined();

      const directDest = path.join(A.downloadsDir, "resume-b.bin");
      await fs.writeFile(directDest, "resume-", "utf8");
      await A.node.downloadResult(directHit!.resultNo, directDest);
      await waitFor(
        () =>
          eventsOfType(A, "DOWNLOAD_SUCCEEDED").some(
            (event) =>
              event.mode === "direct" &&
              event.fileName === "resume-b.bin" &&
              event.destPath === directDest,
          ),
        "A to complete a managed direct download",
      );
      await expect(fs.readFile(directDest, "utf8")).resolves.toBe(
        "resume-from-b",
      );

      const directDownloads = eventsOfType(A, "DOWNLOAD_SUCCEEDED").filter(
        (event) => event.mode === "direct",
      );
      expect(directDownloads).toContainEqual(
        expect.objectContaining({
          fileName: "resume-b.bin",
          destPath: directDest,
          remoteHost: "127.0.0.1",
          remotePort: B.listenPort,
        }),
      );

      const pushBefore = A.node.sendQuery("push-only-c", 2)!.id;
      await waitFor(
        () =>
          newResults(A, pushBefore).some(
            (hit) => hit.fileName === "push-only-c.bin",
          ),
        "A to receive 0.6 push-only result from C",
      );

      const pushHit = newResults(A, pushBefore).find(
        (hit) => hit.fileName === "push-only-c.bin",
      );
      expect(pushHit).toEqual(
        expect.objectContaining({
          fileName: "push-only-c.bin",
          remotePort: badPort,
        }),
      );

      const pushDest = path.join(A.downloadsDir, "push-only-c.bin");
      await A.node.downloadResult(pushHit!.resultNo, pushDest);
      await waitFor(
        () =>
          eventsOfType(A, "DOWNLOAD_SUCCEEDED").some(
            (event) =>
              event.mode === "push" &&
              event.fileName === "push-only-c.bin" &&
              event.destPath === pushDest,
          ),
        "A to complete a managed push download",
      );
      await expect(fs.readFile(pushDest, "utf8")).resolves.toBe(
        "push-from-c",
      );

      const directFailures = eventsOfType(A, "DOWNLOAD_DIRECT_FAILED");
      expect(directFailures).toContainEqual(
        expect.objectContaining({
          fileName: "push-only-c.bin",
          remoteHost: "127.0.0.1",
          remotePort: badPort,
        }),
      );

      const pushDownloads = eventsOfType(A, "DOWNLOAD_SUCCEEDED").filter(
        (event) => event.mode === "push",
      );
      expect(pushDownloads).toContainEqual(
        expect.objectContaining({
          fileName: "push-only-c.bin",
          destPath: pushDest,
          remoteHost: "127.0.0.1",
          remotePort: badPort,
        }),
      );
      expect(eventsOfType(C, "PUSH_REQUESTED")).toContainEqual(
        expect.objectContaining({
          fileName: "push-only-c.bin",
          ip: "127.0.0.1",
          port: A.listenPort,
        }),
      );

      await A.node.save();
      const saved = JSON.parse(await fs.readFile(A.configPath, "utf8"));
      expect(saved.state.peers).toEqual(
        expect.objectContaining({
          [`127.0.0.1:${B.listenPort}`]: expect.any(Number),
          [`127.0.0.1:${badPort}`]: expect.any(Number),
        }),
      );
      expect(saved.state.downloads).toBeUndefined();
      expect(A.node.getDownloads()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fileName: "resume-b.bin",
            mode: "direct",
            host: "127.0.0.1",
            port: B.listenPort,
            destPath: directDest,
          }),
          expect.objectContaining({
            fileName: "push-only-c.bin",
            mode: "push",
            host: "127.0.0.1",
            port: badPort,
            destPath: pushDest,
          }),
        ]),
      );
    });
  });

  test("routes leaf traffic through a real ultrapeer and shields non-matching leaves with QRP", async () => {
    await withFakeNet(async () => {
      await withTempDir(async (root) => {
        const [leafAPort, ultraPort, leafCPort] = await Promise.all([
          getFreePort(),
          getFreePort(),
          getFreePort(),
        ]);

        const leafA = await createMeshNode(root, "A", {
          listenPort: leafAPort,
          advertisedPort: leafAPort,
          advertisedSpeedKBps: 128,
          peers: [`127.0.0.1:${ultraPort}`],
          shares: {},
          ultrapeer: false,
          enableQrp: true,
        });
        const ultra = await createMeshNode(root, "B", {
          listenPort: ultraPort,
          advertisedPort: ultraPort,
          advertisedSpeedKBps: 512,
          peers: [],
          shares: {
            "ultra-own.txt": "from the center",
          },
          ultrapeer: true,
          enableQrp: true,
          maxConnections: 2,
          maxLeafConnections: 4,
        });
        const leafC = await createMeshNode(root, "C", {
          listenPort: leafCPort,
          advertisedPort: leafCPort,
          advertisedSpeedKBps: 128,
          peers: [`127.0.0.1:${ultraPort}`],
          shares: {
            "ultra-hit-c.txt": "matched only by C",
          },
          ultrapeer: false,
          enableQrp: true,
        });

        try {
          await ultra.node.start();
          await leafA.node.start();
          await leafC.node.start();

          await waitFor(
            () =>
              leafA.node.connections.peerCount() === 1 &&
              leafC.node.connections.peerCount() === 1 &&
              ultra.node.connections.connectedLeafCount() === 2 &&
              ultra.node.connections.connectedMeshPeerCount() === 0,
            "leaf/ultrapeer topology to come online",
          );

          await sleep(1200);

          const leafConnection = [
            ...leafA.node.connections.peers.values(),
          ][0]!;
          const remoteLeaf = [
            ...ultra.node.connections.peers.values(),
          ].find(
            (peer) =>
              peer.role === "leaf" &&
              peer.socket.remotePort === leafConnection.socket.localPort,
          );
          expect(remoteLeaf).toBeDefined();
          if (!remoteLeaf) throw new Error("missing leaf A connection");
          const remoteQrp = () =>
            ultra.node.router.peerState(remoteLeaf).qrp;
          const sentQrpCount = () =>
            eventsOfType(leafA, "PEER_MESSAGE_SENT").filter(
              (event) => event.payloadType === TYPE.ROUTE_TABLE_UPDATE,
            ).length;
          await waitFor(
            () => remoteQrp().table !== null,
            "empty leaf QRP advertisement",
          );
          await leafA.node.router.sendQrpTable(leafConnection);
          const initialCount = sentQrpCount();
          expect(initialCount).toBe(2);
          expect(QrpTable.matchesRemote(remoteQrp(), "uniquealpha")).toBe(
            false,
          );
          await leafA.node.refreshShares();
          await leafA.node.refreshShares();
          await leafA.node.router.sendQrpTable(leafConnection);
          expect(sentQrpCount()).toBe(initialCount);

          await writeShare(leafA, "uniquealpha.txt", "alpha");
          await leafA.node.refreshShares();
          await waitFor(
            () => QrpTable.matchesRemote(remoteQrp(), "uniquealpha"),
            "new file to appear in the remote QRP table",
          );
          await leafA.node.router.sendQrpTable(leafConnection);
          expect(sentQrpCount()).toBe(initialCount + 2);
          await leafA.node.refreshShares();
          await leafA.node.router.sendQrpTable(leafConnection);
          expect(sentQrpCount()).toBe(initialCount + 2);

          await fs.unlink(
            path.join(leafA.downloadsDir, "uniquealpha.txt"),
          );
          await leafA.node.refreshShares();
          await waitFor(
            () =>
              remoteQrp().table !== null &&
              !QrpTable.matchesRemote(remoteQrp(), "uniquealpha"),
            "removed file to disappear from the remote QRP table",
          );
          await leafA.node.router.sendQrpTable(leafConnection);
          expect(sentQrpCount()).toBe(initialCount + 4);

          const aResultsBefore = leafA.node.sendQuery(
            "ultra-hit-c",
            2,
          )!.id;
          await waitFor(
            () =>
              newResults(leafA, aResultsBefore).some(
                (hit) => hit.fileName === "ultra-hit-c.txt",
              ),
            "leaf A to receive a result from leaf C through the ultrapeer",
            3_000,
            () =>
              JSON.stringify({
                aPeers: leafA.node.getPeers(),
                ultraPeers: ultra.node.getPeers(),
                cPeers: leafC.node.getPeers(),
                aResults: leafA.node.getResults(aResultsBefore),
                ultraRoutes: [...ultra.node.router.queryRoutes.entries()],
              }),
          );

          const aHit = newResults(leafA, aResultsBefore).find(
            (hit) => hit.fileName === "ultra-hit-c.txt",
          );
          expect(aHit).toEqual(
            expect.objectContaining({
              fileName: "ultra-hit-c.txt",
              remoteHost: "127.0.0.1",
              remotePort: leafCPort,
            }),
          );

          const aQueryEventsBefore = eventsOfType(
            leafA,
            "QUERY_RECEIVED",
          ).length;
          const cQueryEventsBefore = eventsOfType(
            leafC,
            "QUERY_RECEIVED",
          ).length;
          const ultraResultsBefore = ultra.node.sendQuery(
            "ultra-hit-c",
            2,
          )!.id;

          await waitFor(
            () =>
              newResults(ultra, ultraResultsBefore).some(
                (hit) => hit.fileName === "ultra-hit-c.txt",
              ),
            "ultrapeer-local query to be routed to the matching leaf only",
          );

          expect(
            eventsOfType(leafC, "QUERY_RECEIVED").length,
          ).toBeGreaterThan(cQueryEventsBefore);
          expect(eventsOfType(leafA, "QUERY_RECEIVED")).toHaveLength(
            aQueryEventsBefore,
          );
        } finally {
          await Promise.allSettled([
            leafA.node.stop(),
            ultra.node.stop(),
            leafC.node.stop(),
          ]);
        }
      });
    });
  }, 15_000);
});
