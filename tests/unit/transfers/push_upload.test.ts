import { expect, test } from "bun:test";
import { MAX_HEADER_BYTES, TYPE } from "../../../src/const";
import { encodePush } from "../../../src/wire/codec";
import {
  makeHeader,
  makeNode,
  makePeer,
  makeShare,
  MockSocket,
} from "../../helpers/protocol";
import { ManualTimers } from "../../helpers/timers";

test.each([
  ["203.0.113.10", "127.0.0.1", false],
  ["203.0.113.10", "10.0.0.5", false],
  ["203.0.113.10", "169.254.169.254", false],
  ["203.0.113.10", "0.0.0.0", false],
  ["203.0.113.10", "239.255.255.250", false],
  ["203.0.113.10", "1.1.1.1", true],
  ["10.0.0.4", "10.0.0.5", true],
  ["10.0.0.4", "127.0.0.1", false],
  ["127.0.0.1", "127.0.0.2", true],
] as const)(
  "PUSH from %s to %s allowed=%s",
  async (reporter, destination, allowed) => {
    const connections: unknown[] = [];
    const node = makeNode("/tmp/push-policy-test/config.json", {
      collaborators: {
        netFactory: {
          createConnection: (options) => {
            connections.push(options);
            return new MockSocket(destination) as never;
          },
        },
      },
    });
    node.shareLibrary.sharesByIndex.set(
      1,
      makeShare(1, "/tmp/share.txt", "share.txt"),
    );
    const peer = makePeer();
    peer.socket = new MockSocket(reporter) as never;
    try {
      await node.router.onPush(
        peer,
        makeHeader(TYPE.PUSH, 1, 0, 1),
        encodePush(
          Buffer.from(node.getServentIdHex(), "hex"),
          1,
          destination,
          6346,
        ),
      );
      expect(connections).toHaveLength(Number(allowed));
      if (allowed)
        expect(connections[0]).toEqual({ host: destination, port: 6346 });
    } finally {
      await node.stop();
    }
  },
);

test.each([0, 6346])(
  "PUSH rejects invalid ports and blocked destinations (port %s)",
  async (port) => {
    let called = false;
    const node = makeNode("/tmp/push-blocked-test/config.json", {
      runtimeConfig: { blockedIps: ["1.1.1.1"] },
      collaborators: {
        netFactory: {
          createConnection: () => {
            called = true;
            return new MockSocket() as never;
          },
        },
      },
    });
    node.shareLibrary.sharesByIndex.set(
      1,
      makeShare(1, "/tmp/share.txt", "share.txt"),
    );
    try {
      const peer = makePeer();
      await node.router.onPush(
        peer,
        makeHeader(TYPE.PUSH, 1, 0, 1),
        encodePush(
          Buffer.from(node.getServentIdHex(), "hex"),
          1,
          port === 0 ? "9.8.7.6" : "1.1.1.1",
          port,
        ),
      );
      expect(called).toBe(false);
    } finally {
      await node.stop();
    }
  },
);

test.each(["oversized", "trickle", "complete"])(
  "PUSH callback handles %s headers and releases its deadline",
  async (scenario) => {
    const timers = new ManualTimers();
    const socket = new MockSocket("9.8.7.6");
    const node = makeNode("/tmp/push-header-test/config.json", {
      runtimeConfig: { downloadTimeoutMs: 100 },
      collaborators: {
        scheduler: timers.scheduler,
        netFactory: { createConnection: () => socket as never },
      },
    });
    node.shareLibrary.sharesByIndex.set(
      1,
      makeShare(1, "/tmp/share.txt", "share.txt"),
    );
    try {
      await node.transfers.fulfillPush({
        serventId: Buffer.from(node.getServentIdHex(), "hex"),
        serventIdHex: node.getServentIdHex(),
        fileIndex: 1,
        ip: "9.8.7.6",
        port: 6346,
        ggep: Buffer.alloc(0),
      });
      socket.emit("connect");
      expect(socket.writes[0]!.toString()).toContain("GIV 1:");
      socket.emit("data", "GET /missing HTTP/1.1\r\nX-Padding: ");
      if (scenario === "oversized") {
        socket.emit("data", Buffer.alloc(MAX_HEADER_BYTES, 65));
        expect(socket.destroyed).toBe(true);
      } else if (scenario === "trickle") {
        timers.advance(90);
        socket.emit("data", "a");
        timers.advance(10);
        expect(socket.destroyed).toBe(true);
      } else {
        socket.emit("data", "a\r\n\r\n");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(Buffer.concat(socket.writes).toString()).toContain(
          "400 Bad Request",
        );
      }
      expect(timers.pending.size).toBe(0);
    } finally {
      await node.stop();
    }
  },
);
