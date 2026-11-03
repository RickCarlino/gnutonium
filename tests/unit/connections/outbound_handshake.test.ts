import { expect, test } from "bun:test";
import type net from "node:net";
import path from "node:path";
import { PeerConnections } from "../../../src/connections/connections";
import { makeNode, MockSocket, withTempDir } from "../../helpers/protocol";

class DialSocket extends MockSocket {
  timeouts: number[] = [];
  writeError?: Error;

  override setTimeout(ms: number, callback?: () => void): this {
    this.timeouts.push(ms);
    return super.setTimeout(ms, callback);
  }

  override write(chunk: string | Uint8Array<ArrayBufferLike>): boolean {
    if (this.writeError) throw this.writeError;
    return super.write(chunk);
  }
}

test.each(["headers", "write", "error", "close", "timeout"] as const)(
  "outbound %s failures settle the dial and release socket listeners and timeout",
  async (failure) => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const socket = new DialSocket("9.8.7.6", 6346);
      const deps = node.connections.deps;
      const connections = new PeerConnections({
        ...deps,
        network: {
          ...deps.network,
          createConnection: () => socket as unknown as net.Socket,
        },
        address: {
          isSelfPeer: (...args) => deps.address.isSelfPeer(...args),
          currentAdvertisedPort: () =>
            deps.address.currentAdvertisedPort(),
          maybeObserveAdvertisedHost: (...args) =>
            deps.address.maybeObserveAdvertisedHost(...args),
          currentAdvertisedHost: () => {
            if (failure === "headers") throw new Error("headers failed");
            return "127.0.0.1";
          },
        },
      });
      try {
        const dial = connections.connectPeer06("9.8.7.6", 6346, 100);
        const message = {
          headers: "headers failed",
          write: "write failed",
          error: "socket failed",
          close: "socket closed during handshake",
          timeout: "connect timeout",
        }[failure];
        queueMicrotask(() => {
          if (failure === "write") socket.writeError = new Error(message);
          if (failure === "headers" || failure === "write")
            socket.emit("connect");
          else if (failure === "error")
            socket.emit("error", new Error(message));
          else socket.emit(failure);
        });
        await expect(dial).rejects.toThrow(message);
        expect(socket.destroyed).toBe(true);
        expect(socket.timeouts).toEqual([100, 0]);
        for (const event of [
          "connect",
          "data",
          "error",
          "close",
          "timeout",
        ])
          expect(socket.listenerCount(event)).toBe(0);
      } finally {
        await connections.stop();
        await node.stop();
      }
    });
  },
);
