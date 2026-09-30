import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { TYPE } from "../../../src/const";
import {
  buildHeader,
  defaultDoc,
  parseQuery,
} from "../../../src/protocol";
import { encodeQueryHit } from "../../../src/wire/codec";
import {
  makeNode,
  makePeer,
  makeShare,
  MockSocket,
  withTempDir,
} from "../../helpers/protocol";
import { seedSearch } from "../../helpers/search";
import { TestServent as GnutellaServent } from "../../helpers/servent";

class ScriptedSocket extends MockSocket {
  onWrite?: (data: string) => void;

  write(chunk: string | Uint8Array<ArrayBufferLike>): boolean {
    const ok = super.write(chunk);
    this.onWrite?.(Buffer.from(chunk).toString("latin1"));
    return ok;
  }
}

describe("protocol node", () => {
  test("browses one peer with chunked deflate query-hit output", async () => {
    await withTempDir(async (dir) => {
      const alpha = makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt");
      const beta = makeShare(2, path.join(dir, "beta.bin"), "beta.bin");
      const payload = encodeQueryHit(
        6346,
        "9.8.7.6",
        256,
        [alpha, beta],
        Buffer.alloc(16, 0x11),
        {
          vendorCode: "GTKG",
          measuredSpeed: true,
          browseHost: true,
          ggepHashes: true,
        },
      );
      const packet = buildHeader(
        Buffer.alloc(16, 0),
        TYPE.QUERY_HIT,
        0,
        0,
        payload,
      );
      const deflated = zlib.deflateSync(packet);
      const chunked = Buffer.concat([
        Buffer.from(`${deflated.length.toString(16)}\r\n`, "latin1"),
        deflated,
        Buffer.from("\r\n0\r\n\r\n", "latin1"),
      ]);
      const response = Buffer.concat([
        Buffer.from(
          [
            "HTTP/1.1 200 OK",
            "Content-Type: application/x-gnutella-packets",
            "Transfer-Encoding: chunked",
            "Content-Encoding: deflate",
            "Connection: close",
            "",
            "",
          ].join("\r\n"),
          "latin1",
        ),
        chunked,
      ]);

      const requests: string[] = [];
      const socket = new ScriptedSocket("9.8.7.6", 6346);
      let replied = false;
      socket.onWrite = (data) => {
        requests.push(data);
        if (replied) return;
        replied = true;
        queueMicrotask(() => {
          socket.emit("data", response);
          socket.emit("end");
          socket.emit("close", false);
        });
      };

      const node = makeNode(path.join(dir, "protocol.json"), {
        collaborators: {
          netFactory: {
            createConnection: () => {
              queueMicrotask(() => socket.emit("connect"));
              return socket as unknown as net.Socket;
            },
          },
        },
      });
      const peer = makePeer("198.51.100.10:55000");
      peer.key = "p1";
      peer.outbound = true;
      peer.remoteLabel = "9.8.7.6:6346";
      peer.dialTarget = "9.8.7.6:6346";
      peer.capabilities.listenIp = { host: "9.8.7.6", port: 6346 };
      node.connections.peers.set(peer.key, peer);

      const added = await node.browsePeer("p1");

      expect(added.resultCount).toBe(2);
      expect(requests[0]).toContain("GET / HTTP/1.1\r\n");
      expect(requests[0]).toContain(
        "Accept: application/x-gnutella-packets\r\n",
      );
      expect(requests[0]).toContain("Accept-Encoding: deflate\r\n");
      expect(node.getResults(added.id)).toEqual([
        expect.objectContaining({
          resultNo: 1,
          remoteHost: "9.8.7.6",
          remotePort: 6346,
          fileIndex: 1,
          fileName: "alpha.txt",
          viaPeerKey: "p1",
          vendorCode: "GTKG",
        }),
        expect.objectContaining({
          resultNo: 2,
          remoteHost: "9.8.7.6",
          remotePort: 6346,
          fileIndex: 2,
          fileName: "beta.bin",
          viaPeerKey: "p1",
          vendorCode: "GTKG",
        }),
      ]);
    });
  });

  test("browses a direct ip:port without a connected peer", async () => {
    await withTempDir(async (dir) => {
      const alpha = makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt");
      const payload = encodeQueryHit(
        6346,
        "9.8.7.6",
        256,
        [alpha],
        Buffer.alloc(16, 0x22),
        {
          vendorCode: "GTKG",
          measuredSpeed: true,
          browseHost: true,
          ggepHashes: true,
        },
      );
      const packet = buildHeader(
        Buffer.alloc(16, 0),
        TYPE.QUERY_HIT,
        0,
        0,
        payload,
      );
      const response = Buffer.concat([
        Buffer.from(
          [
            "HTTP/1.1 200 OK",
            "Content-Type: application/x-gnutella-packets",
            `Content-Length: ${packet.length}`,
            "Connection: close",
            "",
            "",
          ].join("\r\n"),
          "latin1",
        ),
        packet,
      ]);

      const requests: string[] = [];
      const socket = new ScriptedSocket("9.8.7.6", 6346);
      let replied = false;
      socket.onWrite = (data) => {
        requests.push(data);
        if (replied) return;
        replied = true;
        queueMicrotask(() => {
          socket.emit("data", response);
          socket.emit("end");
          socket.emit("close", false);
        });
      };

      const node = makeNode(path.join(dir, "protocol.json"), {
        collaborators: {
          netFactory: {
            createConnection: () => {
              queueMicrotask(() => socket.emit("connect"));
              return socket as unknown as net.Socket;
            },
          },
        },
      });

      const added = await node.browsePeer("9.8.7.6:6346");

      expect(added.resultCount).toBe(1);
      expect(requests[0]).toContain("Host: 9.8.7.6:6346\r\n");
      expect(node.getResults(added.id)).toEqual([
        expect.objectContaining({
          resultNo: 1,
          remoteHost: "9.8.7.6",
          remotePort: 6346,
          fileIndex: 1,
          fileName: "alpha.txt",
          viaPeerKey: "9.8.7.6:6346",
          vendorCode: "GTKG",
        }),
      ]);
    });
  });

  test("ignores GIV file metadata and downloads the originally requested result", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const socket = new MockSocket("9.8.7.6", 4321);
      const hit = {
        resultNo: 7,
        queryIdHex: "aa".repeat(16),
        queryHops: 2,
        remoteHost: "9.8.7.6",
        remotePort: 4321,
        speedKBps: 128,
        fileIndex: 5,
        fileName: "wanted.bin",
        fileSize: 99,
        serventIdHex: "11".repeat(16),
        viaPeerKey: "p1",
      };
      const destPath = path.join(dir, "downloads", "wanted.bin");
      let captured: {
        fileIndex: number;
        fileName: string;
        destPath: string;
      } | null = null;
      node.transfers.downloadOverSocket = async (
        _socket: net.Socket,
        fileIndex: number,
        fileName: string,
        passedDestPath: string,
      ) => {
        captured = { fileIndex, fileName, destPath: passedDestPath };
        return { destPath, bytes: 8, label: "test source" };
      };
      const resolved = new Promise((resolve, reject) => {
        node.transfers.enqueuePendingPush({
          serventIdHex: hit.serventIdHex,
          result: hit,
          destPath,
          createdAt: Date.now(),
          resolve,
          reject,
        });
      });

      await node.transfers.handleIncomingGiv(
        socket as never,
        `GIV 999:${hit.serventIdHex}/wrong-name.bin\n\n`,
      );

      await expect(resolved).resolves.toEqual({
        destPath,
        bytes: 8,
        label: "test source",
      });
      expect(captured!).toEqual({
        fileIndex: 5,
        fileName: "wanted.bin",
        destPath,
      });
      expect(node.transfers.pendingPushes.has(hit.serventIdHex)).toBe(
        false,
      );
    });
  });

  test("allows any follow-up GET on a push callback socket", async () => {
    await withTempDir(async (dir) => {
      const socket = new MockSocket("5.6.7.8", 7654);
      const node = makeNode(path.join(dir, "protocol.json"), {
        collaborators: {
          netFactory: {
            createConnection: () => socket as unknown as net.Socket,
          },
        },
      });
      const share = makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt");
      node.shareLibrary.shares = [share];
      node.shareLibrary.sharesByIndex = new Map([[share.index, share]]);

      let headSeen = "";
      let existingCalled = false;
      node.transfers.handleIncomingGet = async (
        _socket: net.Socket,
        head: string,
      ) => {
        headSeen = head;
        return false;
      };
      node.transfers.handleExistingGet = async () => {
        existingCalled = true;
        return false;
      };

      await node.transfers.fulfillPush({
        serventId: Buffer.from(node.getServentIdHex(), "hex"),
        serventIdHex: node.getServentIdHex(),
        fileIndex: 1,
        ip: "5.6.7.8",
        port: 7654,
        ggep: Buffer.alloc(0),
      });
      socket.emit("connect");
      socket.emit(
        "data",
        Buffer.from("GET /get/2/other.bin HTTP/1.0\r\n\r\n", "latin1"),
      );
      await Promise.resolve();

      expect(socket.writes[0]?.toString("latin1")).toContain(
        `GIV 1:${node.getServentIdHex()}/alpha.txt`,
      );
      expect(headSeen).toBe("GET /get/2/other.bin HTTP/1.0\r\n\r\n");
      expect(existingCalled).toBe(false);
    });
  });

  test("serves clear HTTP errors for missing shares and invalid ranges", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const missingSocket = new MockSocket("9.8.7.6", 4321);

      await expect(
        node.transfers.handleIncomingGet(
          missingSocket as never,
          "GET /get/99/missing.bin HTTP/1.0\r\n\r\n",
        ),
      ).resolves.toBe(false);

      expect(missingSocket.ended).toBe(true);
      expect(missingSocket.writes[0]?.toString("latin1")).toBe(
        "HTTP/1.0 404 Not Found\r\n\r\n",
      );

      const filePath = path.join(dir, "alpha.txt");
      await fs.writeFile(filePath, "hello", "utf8");
      const rangeSocket = new MockSocket("9.8.7.6", 4321);
      const keepAlive = await node.transfers.handleExistingGet(
        rangeSocket as never,
        [
          "GET /get/1/alpha.txt HTTP/1.1",
          "Range: bytes=99-120",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
        filePath,
      );

      expect(keepAlive).toBe(false);
      expect(rangeSocket.ended).toBe(true);
      expect(rangeSocket.writes[0]?.toString("latin1")).toContain(
        "HTTP/1.1 416 Range Not Satisfiable\r\n",
      );
      expect(rangeSocket.writes[0]?.toString("latin1")).toContain(
        "Content-Range: bytes */5\r\n",
      );
    });
  });

  test("streams existing GET bodies and reports stream failures", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const filePath = path.join(dir, "alpha.txt");
      const socket = new MockSocket("9.8.7.6", 4321);

      await fs.writeFile(filePath, "hello", "utf8");
      await expect(
        node.transfers.streamExistingGetBody(
          socket as never,
          filePath,
          { start: 1, end: 3 },
          false,
        ),
      ).resolves.toBeUndefined();

      expect(socket.ended).toBe(true);
      expect(Buffer.concat(socket.writes).toString("utf8")).toBe("ell");

      const failedSocket = new MockSocket("9.8.7.6", 4321);
      await expect(
        node.transfers.streamExistingGetBody(
          failedSocket as never,
          path.join(dir, "missing.bin"),
          { start: 0, end: 1 },
          true,
        ),
      ).rejects.toThrow();
    });
  });

  test("rejects malformed or unmatched GIV callbacks", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const malformed = new MockSocket("9.8.7.6", 4321);
      const unmatched = new MockSocket("9.8.7.6", 4321);

      await node.transfers.handleIncomingGiv(
        malformed as never,
        "GIV nope\n\n",
      );
      await node.transfers.handleIncomingGiv(
        unmatched as never,
        `GIV 1:${"11".repeat(16)}/alpha.txt\n\n`,
      );

      expect(malformed.destroyed).toBe(true);
      expect(unmatched.destroyed).toBe(true);
    });
  });

  test("downloads over an existing socket using the current file size as a range start", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const socket = new MockSocket("9.8.7.6", 4321);
      const destPath = path.join(dir, "downloads", "alpha.txt");
      let captured: {
        destPath: string;
        label: string;
        existing: number;
      } | null = null;

      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, "hello", "utf8");
      node.transfers.readHttpDownload = async (
        _socket: net.Socket,
        passedDestPath: string,
        label: string,
        existing: number,
      ) => {
        captured = { destPath: passedDestPath, label, existing };
        return { destPath: passedDestPath, bytes: existing, label };
      };

      await expect(
        node.transfers.downloadOverSocket(
          socket as never,
          7,
          "alpha.txt",
          destPath,
        ),
      ).resolves.toMatchObject({ destPath, bytes: 5 });

      expect(socket.writes).toHaveLength(1);
      expect(socket.writes[0]?.toString("latin1")).toBe(
        "GET /get/7/alpha.txt HTTP/1.1\r\nUser-Agent: Gnutonium/2.1.1\r\nHost: 9.8.7.6:4321\r\nConnection: Keep-Alive\r\nRange: bytes=5-\r\n\r\n",
      );
      expect(captured!).toEqual({
        destPath,
        label: "9.8.7.6:4321",
        existing: 5,
      });
    });
  });

  test("reads HTTP downloads for both resume success and truncated responses", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const resumedSocket = new MockSocket("9.8.7.6", 4321);
      const resumedPath = path.join(dir, "downloads", "resume.bin");

      await fs.mkdir(path.dirname(resumedPath), { recursive: true });
      await fs.writeFile(resumedPath, "hello", "utf8");

      const resumed = node.transfers.readHttpDownload(
        resumedSocket as never,
        resumedPath,
        "9.8.7.6:4321",
        5,
      );
      resumedSocket.emit(
        "data",
        Buffer.from(
          "HTTP/1.0 206 Partial Content\r\nContent-length: 3\r\nContent-Range: bytes 5-7/8\r\n\r\nXYZ",
          "latin1",
        ),
      );

      await expect(resumed).resolves.toEqual({
        destPath: resumedPath,
        bytes: 8,
        range: { start: 5, end: 7, total: 8 },
        connectionClose: true,
        label: "9.8.7.6:4321",
      });
      await expect(fs.readFile(resumedPath, "utf8")).resolves.toBe(
        "helloXYZ",
      );
      expect(resumedSocket.ended).toBe(false);

      const zeroStartSocket = new MockSocket("9.8.7.6", 4321);
      const zeroStartPath = path.join(dir, "downloads", "zero-start.bin");
      const zeroStart = node.transfers.readHttpDownload(
        zeroStartSocket as never,
        zeroStartPath,
        "9.8.7.6:4321",
        0,
      );
      zeroStartSocket.emit(
        "data",
        Buffer.from(
          "HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nContent-Range: bytes 0-4/5\r\n\r\nhello",
          "latin1",
        ),
      );

      await expect(zeroStart).resolves.toEqual({
        destPath: zeroStartPath,
        bytes: 5,
        range: { start: 0, end: 4, total: 5 },
        label: "9.8.7.6:4321",
      });
      await expect(fs.readFile(zeroStartPath, "utf8")).resolves.toBe(
        "hello",
      );
      expect(zeroStartSocket.ended).toBe(false);

      const truncatedSocket = new MockSocket("9.8.7.6", 4321);
      const truncatedPath = path.join(dir, "downloads", "truncated.bin");
      const truncated = node.transfers.readHttpDownload(
        truncatedSocket as never,
        truncatedPath,
        "9.8.7.6:4321",
        0,
      );
      truncatedSocket.emit(
        "data",
        Buffer.from(
          "HTTP/1.0 200 OK\r\nContent-length: 5\r\n\r\nabc",
          "latin1",
        ),
      );
      truncatedSocket.emit("end");

      await expect(truncated).rejects.toThrow(
        "connection closed before full body received",
      );
      expect(truncatedSocket.destroyed).toBe(true);
    });
  });

  test("falls back from uri-res requests to /get downloads when direct urn downloads fail", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const destPath = path.join(dir, "downloads", "alpha.txt");
      const requests: string[] = [];
      const existingSizes: number[] = [];
      const hit = {
        resultNo: 7,
        queryIdHex: "aa".repeat(16),
        queryHops: 2,
        remoteHost: "9.8.7.6",
        remotePort: 4321,
        speedKBps: 128,
        fileIndex: 5,
        fileName: "alpha.txt",
        fileSize: 99,
        serventIdHex: "11".repeat(16),
        viaPeerKey: "p1",
        sha1Urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      };

      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, "hello", "utf8");
      node.transfers.directDownloadViaRequest = async (
        _host: string,
        _port: number,
        request: string,
        _passedDestPath: string,
        existing: number,
      ) => {
        requests.push(request);
        existingSizes.push(existing);
        if (requests.length === 1) {
          await fs.appendFile(destPath, "XYZ");
          throw new Error("uri-res failed");
        }
        return { destPath, bytes: 8, label: "test source" };
      };

      await expect(
        node.transfers.directDownload(hit as never, destPath),
      ).resolves.toEqual({ destPath, bytes: 8, label: "test source" });

      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain(
        "GET /uri-res/N2R?urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA HTTP/1.1",
      );
      expect(requests[1]).toContain("GET /get/5/alpha.txt HTTP/1.1");
      expect(existingSizes).toEqual([5, 8]);
      expect(requests[1]).toContain("Range: bytes=8-");
    });
  });

  test("downloadResult creates a managed background download job", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const events: string[] = [];
      const node = new GnutellaServent(configPath, doc, {
        onEvent: (event) => events.push(event.type),
      });
      const hit = {
        resultNo: 7,
        queryIdHex: "aa".repeat(16),
        queryHops: 2,
        remoteHost: "9.8.7.6",
        remotePort: 4321,
        speedKBps: 128,
        fileIndex: 5,
        fileName: "alpha.txt",
        fileSize: 99,
        serventIdHex: "11".repeat(16),
        viaPeerKey: "p1",
      };
      const fallbackPath = path.join(dir, "custom", "push.bin");

      const search = seedSearch(node, [hit]);
      events.length = 0;

      const job = await node.downloadResult(1);
      expect(job).toMatchObject({
        id: "d1",
        status: "queued",
        fileName: "alpha.txt",
        destPath: path.resolve(
          path.join(node.config().downloadsDir, "alpha.txt"),
        ),
      });
      expect(node.getDownloadJobs()).toHaveLength(1);
      expect(node.getDownloadJobs()[0]?.sources).toHaveLength(1);
      expect(node.getDownloads()).toHaveLength(0);
      expect(events).toEqual(["DOWNLOAD_QUEUED"]);

      events.length = 0;

      const custom = await node.downloadResult(1, fallbackPath);
      expect(custom).toMatchObject({
        id: "d2",
        status: "queued",
        destPath: path.resolve(fallbackPath),
      });
      expect(node.getDownloadJobs()).toHaveLength(2);
      expect(events).toEqual(["DOWNLOAD_QUEUED"]);
      expect(node.getResults(search.id)).toHaveLength(1);
    });
  });

  test("downloadResult auto-picks a unique filename when the default path already exists", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const node = new GnutellaServent(configPath, doc);
      const hit = {
        resultNo: 7,
        queryIdHex: "aa".repeat(16),
        queryHops: 2,
        remoteHost: "9.8.7.6",
        remotePort: 4321,
        speedKBps: 128,
        fileIndex: 5,
        fileName: "alpha.txt",
        fileSize: 99,
        serventIdHex: "11".repeat(16),
        viaPeerKey: "p1",
      };
      const occupiedPath = path.join(
        node.config().downloadsDir,
        "alpha.txt",
      );
      let seenDestPath = "";

      await fs.mkdir(path.dirname(occupiedPath), { recursive: true });
      await fs.writeFile(occupiedPath, "existing", "utf8");
      seedSearch(node, [hit]);

      const job = await node.downloadResult(1);
      seenDestPath = job.destPath;

      expect(seenDestPath).toBe(
        path.resolve(
          path.join(node.config().downloadsDir, "alpha (2).txt"),
        ),
      );
      expect(node.getDownloadJobs()[0]).toMatchObject({
        destPath: path.resolve(
          path.join(node.config().downloadsDir, "alpha (2).txt"),
        ),
      });
    });
  });

  test("emits skipped and sent query events and exposes peer-facing getters", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const events: string[] = [];
      const node = new GnutellaServent(configPath, doc, {
        onEvent: (event) => events.push(event.type),
      });
      let pingTtl = -1;
      let queryArgs: {
        ttl: number;
        search: string;
        parsedSearch: string;
        maxHits: number;
        urns: string[];
      } | null = null;

      node.connections.sendToPeer = (
        _peer: unknown,
        payloadType: number,
        _descriptorId: Buffer,
        ttl: number,
        _hops: number,
        _payload: Buffer,
      ) => {
        if (payloadType !== TYPE.PING) return;
        pingTtl = ttl;
      };
      const queries: Array<{
        ttl: number;
        search: string;
        parsedSearch: string;
        maxHits: number;
        urns: string[];
      }> = [];
      node.router.broadcastQuery = (
        _descriptorId: Buffer,
        ttl: number,
        _hops: number,
        payload: Buffer,
        search: string,
      ) => {
        const parsed = parseQuery(payload);
        queryArgs = {
          ttl,
          search,
          parsedSearch: parsed.search,
          maxHits: parsed.maxHits,
          urns: parsed.urns,
        };
        queries.push(queryArgs);
      };

      node.sendQuery("alpha");
      expect(events).toEqual(["QUERY_SKIPPED"]);

      const peer = makePeer("p1");
      peer.remoteLabel = "9.8.7.6:4321";
      peer.outbound = true;
      peer.dialTarget = "9.8.7.6:4321";
      node.connections.peers.set(peer.key, peer as never);

      node.sendPing(99);
      node.sendQuery("alpha");
      node.sendQuery("alpha", 99);

      expect(pingTtl).toBe(node.config().maxTtl);
      expect(queryArgs!).toEqual({
        ttl: node.config().maxTtl,
        search: "alpha",
        parsedSearch: "alpha",
        maxHits: node.config().maxResultsPerQuery,
        urns: [],
      });
      expect(queries).toEqual([
        {
          ttl: node.config().defaultQueryTtl,
          search: "alpha",
          parsedSearch: "alpha",
          maxHits: node.config().maxResultsPerQuery,
          urns: [],
        },
        {
          ttl: node.config().maxTtl,
          search: "alpha",
          parsedSearch: "alpha",
          maxHits: node.config().maxResultsPerQuery,
          urns: [],
        },
      ]);

      node.sendQuery("urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2 alpha", 2);

      expect(queries.at(-1)).toEqual({
        ttl: 2,
        search: "urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2 alpha",
        parsedSearch: "alpha",
        maxHits: node.config().maxResultsPerQuery,
        urns: ["urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2"],
      });
      expect(events).toEqual([
        "QUERY_SKIPPED",
        "PING_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
      ]);

      node.sendQuery("urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2", 2);

      expect(queries.at(-1)).toEqual({
        ttl: 2,
        search: "urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2",
        parsedSearch: "",
        maxHits: node.config().maxResultsPerQuery,
        urns: ["urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2"],
      });

      node.sendQuery(
        "urn:bitprint:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA alpha",
        2,
      );

      expect(queries.at(-1)).toEqual({
        ttl: 2,
        search:
          "urn:bitprint:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA alpha",
        parsedSearch: "alpha",
        maxHits: node.config().maxResultsPerQuery,
        urns: [
          "urn:bitprint:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2",
        ],
      });

      node.sendQuery(
        "magnet:?xt=urn%3Abitprint%3ATXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=alpha%20beta.bin",
        2,
      );

      expect(queries.at(-1)).toEqual({
        ttl: 2,
        search:
          "magnet:?xt=urn%3Abitprint%3ATXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=alpha%20beta.bin",
        parsedSearch: "alpha beta.bin",
        maxHits: node.config().maxResultsPerQuery,
        urns: [
          "urn:bitprint:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2",
        ],
      });

      node.sendQuery("    ", 1);

      expect(queries.at(-1)).toEqual({
        ttl: 1,
        search: "    ",
        parsedSearch: "    ",
        maxHits: node.config().maxResultsPerQuery,
        urns: [],
      });
      expect(events).toEqual([
        "QUERY_SKIPPED",
        "PING_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
      ]);
      expect(node.getPeers()).toEqual([
        {
          key: "p1",
          remoteLabel: "9.8.7.6:4321",
          browseTarget: "9.8.7.6:4321",
          role: "leaf",
          outbound: true,
          dialTarget: "9.8.7.6:4321",
          compression: false,
          tls: false,
        },
      ]);
      expect(node.getServentIdHex()).toMatch(/^[0-9a-f]{32}$/);
      expect(node.getStatus()).toEqual({
        peers: 1,
        shares: 0,
        results: 0,
        knownPeers: 0,
      });

      const search = node.getSearches()[0]!;
      node.clearResults(search.id);
      expect(() => node.getResults(search.id)).toThrow("no such search");
      expect(node.getStatus()).toEqual({
        peers: 1,
        shares: 0,
        results: 0,
        knownPeers: 0,
      });
      await expect(node.downloadResult(99)).rejects.toThrow(
        "no such result 99",
      );
    });
  });
});

test("rejects excessive browse-host inflation", async () => {
  await withTempDir(async (dir) => {
    const socket = new ScriptedSocket();
    const body = zlib.deflateSync(Buffer.alloc(16 * 1024 * 1024 + 1));
    socket.onWrite = () => {
      queueMicrotask(() =>
        socket.emit(
          "data",
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 200 OK\r\nContent-Type: application/x-gnutella-packets\r\nContent-Encoding: deflate\r\nContent-Length: ${body.length}\r\n\r\n`,
            ),
            body,
          ]),
        ),
      );
    };
    const node = makeNode(path.join(dir, "config.json"), {
      collaborators: {
        netFactory: {
          createConnection: () => {
            queueMicrotask(() => socket.emit("connect"));
            return socket as unknown as net.Socket;
          },
        },
      },
    });
    try {
      await expect(node.browsePeer("127.0.0.1:6346")).rejects.toThrow(
        "Buffer larger than",
      );
    } finally {
      await node.stop();
    }
    expect(socket.destroyed).toBe(true);
  });
});
