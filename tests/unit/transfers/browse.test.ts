import { describe, expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import { TYPE } from "../../../src/const";
import {
  buildHeader,
  parseHeader,
  parseQueryHit,
} from "../../../src/protocol";
import {
  handleBrowseHostGet,
  isBrowseHostGetRequest,
} from "../../../src/transfers/browse";
import { encodeQueryHit } from "../../../src/wire/codec";
import {
  makeNode,
  makePeer,
  makeShare,
  MockSocket,
  overrideRuntimeConfig,
  withTempDir,
} from "../../helpers/protocol";

function rawWrites(socket: MockSocket): Buffer {
  return Buffer.concat(socket.writes);
}

class ScriptedSocket extends MockSocket {
  private replied = false;

  constructor(
    private readonly response: Buffer | undefined,
    private readonly closeEarly = false,
  ) {
    super("9.8.7.6", 6346);
  }

  override write(chunk: string | Uint8Array<ArrayBufferLike>): boolean {
    const ok = super.write(chunk);
    if (this.replied) return ok;
    this.replied = true;
    queueMicrotask(() => {
      if (this.response) this.emit("data", this.response);
      if (this.closeEarly) {
        this.emit("close", false);
        return;
      }
      this.emit("end");
      this.emit("close", false);
    });
    return ok;
  }
}

function browseResponse(
  headers: readonly string[],
  body: Uint8Array = Buffer.alloc(0),
): Buffer {
  return Buffer.concat([
    Buffer.from([...headers, "", ""].join("\r\n"), "latin1"),
    body,
  ]);
}

async function expectBrowseFailure(
  response: Buffer | undefined,
  expected: string,
  closeEarly = false,
): Promise<void> {
  await withTempDir(async (dir) => {
    const socket = new ScriptedSocket(response, closeEarly);
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

    await expect(node.browsePeer("9.8.7.6:6346")).rejects.toThrow(
      expected,
    );
    expect(socket.ended).toBe(true);
  });
}

describe("browse host", () => {
  test("recognizes root GET and HEAD requests only", () => {
    expect(isBrowseHostGetRequest("GET / HTTP/1.1\r\n\r\n")).toBe(true);
    expect(isBrowseHostGetRequest("HEAD / HTTP/1.0\n\n")).toBe(true);
    expect(
      isBrowseHostGetRequest("GET /get/1/alpha.txt HTTP/1.1\r\n\r\n"),
    ).toBe(false);
    expect(isBrowseHostGetRequest("POST / HTTP/1.1\r\n\r\n")).toBe(false);
  });

  test("rejects browse requests without the packet accept type", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const socket = new MockSocket();

      await expect(
        handleBrowseHostGet(
          node.transfers,
          socket as never,
          "GET / HTTP/1.1\r\nAccept: text/plain\r\n\r\n",
        ),
      ).resolves.toBe(false);

      const response = rawWrites(socket).toString("latin1");
      expect(response).toContain("HTTP/1.1 406 Not Acceptable\r\n");
      expect(response).toContain("Content-Length: 0\r\n");
      expect(response).toContain("X-Features: browse/1.0\r\n");
      expect(socket.ended).toBe(true);
    });
  });

  test("serves HEAD browse requests without a descriptor body", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      node.shareLibrary.shares = [
        makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt"),
      ];
      node.shareLibrary.sharesByIndex = new Map(
        node.shareLibrary.shares.map((share) => [share.index, share]),
      );
      const socket = new MockSocket();

      await expect(
        handleBrowseHostGet(
          node.transfers,
          socket as never,
          [
            "HEAD / HTTP/1.0",
            "Accept: text/plain; q=0.2, application/x-gnutella-packets; q=1",
            "",
            "",
          ].join("\r\n"),
        ),
      ).resolves.toBe(false);

      const response = rawWrites(socket).toString("latin1");
      expect(response).toBe(
        [
          "HTTP/1.0 200 OK",
          "Server: Gnutonium/2.1.1",
          "Content-Type: application/x-gnutella-packets",
          "X-Features: browse/1.0",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
      expect(socket.ended).toBe(true);
    });
  });

  test("serves GET browse requests as query-hit descriptor batches", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      node.shareLibrary.shares = [
        makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt"),
        makeShare(2, path.join(dir, "beta.bin"), "beta.bin"),
      ];
      node.shareLibrary.sharesByIndex = new Map(
        node.shareLibrary.shares.map((share) => [share.index, share]),
      );
      const socket = new MockSocket();

      await handleBrowseHostGet(
        node.transfers,
        socket as never,
        "GET / HTTP/1.1\r\nAccept: application/x-gnutella-packets\r\n\r\n",
      );

      const raw = rawWrites(socket);
      const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"));
      const head = raw.subarray(0, headerEnd + 4).toString("latin1");
      const packet = raw.subarray(headerEnd + 4);
      const descriptor = parseHeader(packet.subarray(0, 23));
      const queryHit = parseQueryHit(
        packet.subarray(23, 23 + descriptor.payloadLength),
      );

      expect(head).toContain("HTTP/1.1 200 OK\r\n");
      expect(head).toContain("Server: Gnutonium/2.1.1\r\n");
      expect(queryHit.vendorCode).toBe("NIUM");
      expect(descriptor).toMatchObject({
        payloadType: TYPE.QUERY_HIT,
        ttl: 0,
        hops: 0,
      });
      expect(queryHit.results.map((result) => result.fileName)).toEqual([
        "alpha.txt",
        "beta.bin",
      ]);
    });
  });

  test("uses an existing peer when browsing by its advertised address", async () => {
    await withTempDir(async (dir) => {
      const share = makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt");
      const payload = encodeQueryHit(
        6346,
        "9.8.7.6",
        256,
        [share],
        Buffer.alloc(16, 0x11),
      );
      const packet = buildHeader(
        Buffer.alloc(16),
        TYPE.QUERY_HIT,
        0,
        0,
        payload,
      );
      const socket = new ScriptedSocket(
        browseResponse(
          [
            "HTTP/1.1 200 OK",
            "Content-Type: application/x-gnutella-packets",
            `Content-Length: ${packet.length}`,
          ],
          packet,
        ),
      );
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
      peer.key = "matched-peer";
      peer.dialTarget = "9.8.7.6:6346";
      node.connections.peers.set(peer.key, peer);

      await expect(node.browsePeer("9.8.7.6:6346")).resolves.toMatchObject(
        { resultCount: 1, kind: "browse", status: "complete" },
      );
      expect(node.getResults(node.getSearches()[0]!.id)[0]).toMatchObject({
        fileName: "alpha.txt",
        viaPeerKey: "matched-peer",
      });
    });
  });

  test("accepts complete close-delimited browse-host responses", async () => {
    await withTempDir(async (dir) => {
      const socket = new ScriptedSocket(
        browseResponse([
          "HTTP/1.1 200 OK",
          "Content-Type: application/x-gnutella-packets",
        ]),
        true,
      );
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

      await expect(node.browsePeer("9.8.7.6:6346")).resolves.toMatchObject(
        { resultCount: 0, kind: "browse", status: "complete" },
      );
    });
  });

  test("rejects invalid, self, and non-browseable targets before dialing", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      overrideRuntimeConfig(node, {
        advertisedHost: "9.8.7.6",
        advertisedPort: 6346,
        listenHost: "0.0.0.0",
        listenPort: 6346,
      });

      await expect(node.browsePeer("not-a-peer")).rejects.toThrow(
        "no such peer not-a-peer",
      );
      await expect(node.browsePeer("9.8.7.6:6346")).rejects.toThrow(
        "cannot browse self",
      );

      const selfOnlyPeer = makePeer("9.8.7.6:6346");
      selfOnlyPeer.key = "self-peer";
      selfOnlyPeer.remoteLabel = "9.8.7.6:6346";
      selfOnlyPeer.dialTarget = "9.8.7.6:6346";
      selfOnlyPeer.capabilities.listenIp = {
        host: "9.8.7.6",
        port: 6346,
      };
      node.connections.peers.set(selfOnlyPeer.key, selfOnlyPeer);

      await expect(node.browsePeer("self-peer")).rejects.toThrow(
        "peer self-peer has no browseable ip:port",
      );
    });
  });

  test("reports invalid browse-host HTTP responses", async () => {
    await expectBrowseFailure(
      undefined,
      "missing browse-host HTTP response headers",
    );
    await expectBrowseFailure(
      browseResponse(["HTTP/1.1 406 Not Acceptable"]),
      "browse host rejected application/x-gnutella-packets",
    );
    await expectBrowseFailure(
      browseResponse(["HTTP/1.1 503 Busy"]),
      "browse host failed with HTTP/1.1 503 Busy",
    );
    await expectBrowseFailure(
      browseResponse(["NOT HTTP"]),
      "invalid browse-host HTTP response",
    );
    await expectBrowseFailure(
      browseResponse(["HTTP/1.1 200 OK", "Content-Type: text/plain"]),
      'unexpected browse-host content type "text/plain"',
    );
  });

  test("reports unsupported and malformed browse-host response bodies", async () => {
    await expectBrowseFailure(
      browseResponse([
        "HTTP/1.1 200 OK",
        "Content-Type: application/x-gnutella-packets",
        "Transfer-Encoding: gzip",
      ]),
      'unsupported Transfer-Encoding "gzip"',
    );
    await expectBrowseFailure(
      browseResponse([
        "HTTP/1.1 200 OK",
        "Content-Type: application/x-gnutella-packets",
        "Content-Encoding: gzip",
      ]),
      'unsupported Content-Encoding "gzip"',
    );
    await expectBrowseFailure(
      browseResponse(
        [
          "HTTP/1.1 200 OK",
          "Content-Type: application/x-gnutella-packets",
          "Transfer-Encoding: chunked",
        ],
        Buffer.from("not-hex\r\n", "latin1"),
      ),
      'invalid browse-host chunk size "not-hex"',
    );
    await expectBrowseFailure(
      browseResponse(
        [
          "HTTP/1.1 200 OK",
          "Content-Type: application/x-gnutella-packets",
          "Transfer-Encoding: chunked",
        ],
        Buffer.from("3\r\nabcXX", "latin1"),
      ),
      "invalid browse-host chunk terminator",
    );
    await expectBrowseFailure(
      browseResponse(
        [
          "HTTP/1.1 200 OK",
          "Content-Type: application/x-gnutella-packets",
          "Transfer-Encoding: chunked",
        ],
        Buffer.from("3\r\nabc\r\n", "latin1"),
      ),
      "truncated browse-host chunked stream",
    );
    await expectBrowseFailure(
      browseResponse(
        [
          "HTTP/1.1 200 OK",
          "Content-Type: application/x-gnutella-packets",
          "Content-Length: 10",
        ],
        Buffer.from("short", "latin1"),
      ),
      "incomplete browse-host HTTP response body",
    );
  });

  test("reports malformed browse-host packet streams", async () => {
    await expectBrowseFailure(
      browseResponse(
        [
          "HTTP/1.1 200 OK",
          "Content-Type: application/x-gnutella-packets",
        ],
        Buffer.alloc(1),
      ),
      "truncated browse-host packet header",
    );
    await expectBrowseFailure(
      browseResponse(
        [
          "HTTP/1.1 200 OK",
          "Content-Type: application/x-gnutella-packets",
        ],
        buildHeader(Buffer.alloc(16), TYPE.PING, 0, 0, Buffer.alloc(0)),
      ),
      "unexpected browse-host packet type 0x0",
    );

    const payload = Buffer.from([1, 2, 3]);
    const truncated = buildHeader(
      Buffer.alloc(16),
      TYPE.QUERY_HIT,
      0,
      0,
      payload,
    ).subarray(0, 23 + payload.length - 1);
    await expectBrowseFailure(
      browseResponse(
        [
          "HTTP/1.1 200 OK",
          "Content-Type: application/x-gnutella-packets",
        ],
        truncated,
      ),
      "truncated browse-host packet payload",
    );
  });

  test("reports browse-host connection errors before and after request", async () => {
    await withTempDir(async (dir) => {
      const socket = new MockSocket("9.8.7.6", 6346);
      const node = makeNode(path.join(dir, "protocol.json"), {
        collaborators: {
          netFactory: {
            createConnection: () => {
              queueMicrotask(() =>
                socket.emit("error", new Error("dial failed")),
              );
              return socket as unknown as net.Socket;
            },
          },
        },
      });

      await expect(node.browsePeer("9.8.7.6:6346")).rejects.toThrow(
        "dial failed",
      );
    });

    await expectBrowseFailure(
      Buffer.from("HTTP/1.1 200 OK\r\n", "latin1"),
      "browse-host connection closed before response completed",
      true,
    );
  });
});
