import { expect, test } from "bun:test";
import { MAX_HEADER_BYTES } from "../../../src/const";
import { makeNode, MockSocket } from "../../helpers/protocol";
import { ManualTimers } from "../../helpers/timers";

test.each([
  "GNUTELLA CONNECT/0.6\r\n",
  "GNUTELLA CONNECT/0.4\r\n",
  "GIV 1:00112233445566778899aabbccddeeff/file.txt\n",
])("rejects oversized fragmented %s headers", async (prefix) => {
  const timers = new ManualTimers();
  const node = makeNode("/tmp/probe-limit-test/config.json", {
    collaborators: { scheduler: timers.scheduler },
  });
  const socket = new MockSocket();
  try {
    node.connections.handleProbe(socket as never);
    socket.emit("data", prefix);
    socket.emit("data", Buffer.alloc(MAX_HEADER_BYTES / 2, 65));
    expect(socket.destroyed).toBe(false);
    socket.emit("data", Buffer.alloc(MAX_HEADER_BYTES / 2, 65));
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("data")).toBe(0);
    expect(timers.pending.size).toBe(0);
  } finally {
    socket.destroy();
    await node.stop();
  }
});

test("inbound deadline covers idle and trickling clients through the final handshake", async () => {
  const timers = new ManualTimers();
  const node = makeNode("/tmp/probe-timeout-test/config.json", {
    runtimeConfig: { connectTimeoutMs: 100, enableTls: false },
    collaborators: { scheduler: timers.scheduler },
  });
  const idle = new MockSocket();
  const partial = new MockSocket();
  try {
    node.connections.handleProbe(idle as never);
    node.connections.handleProbe(partial as never);
    timers.advance(60);
    partial.emit(
      "data",
      "GNUTELLA CONNECT/0.6\r\nX-Ultrapeer: true\r\n\r\n",
    );
    expect(Buffer.concat(partial.writes).toString()).toContain("200 OK");
    timers.advance(30);
    partial.emit("data", "GNUTELLA/0.6 200 OK\r\nX-Padding: ");
    expect(partial.destroyed).toBe(false);
    timers.advance(10);
    expect(idle.destroyed).toBe(true);
    expect(partial.destroyed).toBe(true);
    expect(timers.pending.size).toBe(0);
  } finally {
    idle.destroy();
    partial.destroy();
    await node.stop();
  }
});

test("oversized final headers cannot bypass the initial handshake limit", async () => {
  const node = makeNode("/tmp/probe-final-limit-test/config.json", {
    runtimeConfig: { enableTls: false },
  });
  const socket = new MockSocket();
  try {
    node.connections.handleProbe(socket as never);
    socket.emit(
      "data",
      "GNUTELLA CONNECT/0.6\r\nX-Ultrapeer: true\r\n\r\n",
    );
    socket.emit(
      "data",
      `GNUTELLA/0.6 200 OK\r\nX-Padding: ${"x".repeat(MAX_HEADER_BYTES)}\r\n\r\n`,
    );
    expect(socket.destroyed).toBe(true);
    expect(node.getPeers()).toHaveLength(0);
  } finally {
    socket.destroy();
    await node.stop();
  }
});
