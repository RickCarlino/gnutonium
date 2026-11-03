import { describe, expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import { makeNode, MockSocket, withTempDir } from "../../helpers/protocol";

describe("protocol node connection logging", () => {
  test("logs inbound probes that terminate before the handshake completes", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const debugEvents: Array<{ phase: string; message: string }> = [];

      try {
        node.subscribe((event) => {
          if (event.type !== "HANDSHAKE_DEBUG") return;
          debugEvents.push({
            phase: event.phase,
            message: event.message,
          });
        });

        const socket = new MockSocket("9.8.7.6", 6346);
        node.connections.handleProbe(socket as never);
        socket.emit("data", "GNUTELLA CONNECT/0.6\r\nUser-Agent: Partial");
        socket.emit("close", false);

        expect(debugEvents).toEqual(
          expect.arrayContaining([
            {
              phase: "probe-open",
              message: "awaiting inbound protocol bytes",
            },
            expect.objectContaining({
              phase: "terminated-early",
              message: expect.stringContaining("reason=close"),
            }),
            expect.objectContaining({
              phase: "terminated-early",
              message: expect.stringContaining("mode=undecided"),
            }),
            expect.objectContaining({
              phase: "terminated-early",
              message: expect.stringContaining("bytes="),
            }),
            expect.objectContaining({
              phase: "terminated-early",
              message: expect.stringContaining(
                'preview="GNUTELLA CONNECT/0.6\\\\r\\\\nUser-Agent: Partial"',
              ),
            }),
          ]),
        );
      } finally {
        await node.stop();
      }
    });
  });

  test("rejects and blocks inbound foxy clients", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const probeMessages: string[] = [];
      const debugEvents: Array<{ phase: string; message: string }> = [];

      try {
        node.subscribe((event) => {
          if (event.type === "PROBE_REJECTED") {
            probeMessages.push(event.message);
            return;
          }
          if (event.type !== "HANDSHAKE_DEBUG") return;
          debugEvents.push({
            phase: event.phase,
            message: event.message,
          });
        });

        const socket = new MockSocket("9.8.7.6", 6346);
        node.connections.handleProbe(socket as never);
        socket.emit(
          "data",
          "GNUTELLA CONNECT/0.6\r\nUser-Agent: Foxy/1.0\r\n\r\n",
        );

        expect(Buffer.concat(socket.writes).toString("latin1")).toContain(
          "GNUTELLA/0.6 503 Blocked client\r\n",
        );
        expect(node.getBlockedIps()).toEqual(["9.8.7.6"]);
        expect(probeMessages).toEqual([
          'blocked client signature="Foxy/1.0" ip=9.8.7.6',
        ]);
        expect(debugEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              phase: "blocked-client",
              message: 'blocked client signature="Foxy/1.0" ip=9.8.7.6',
            }),
          ]),
        );
      } finally {
        await node.stop();
      }
    });
  });

  test("rejects and blocks outbound foxy clients", async () => {
    await withTempDir(async (dir) => {
      const debugEvents: Array<{ phase: string; message: string }> = [];
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
              queueMicrotask(() => {
                socket.emit("connect");
                queueMicrotask(() =>
                  socket.emit(
                    "data",
                    "GNUTELLA/0.6 200 OK\r\nUser-Agent: Foxy/2.0\r\n\r\n",
                  ),
                );
              });
              return socket as unknown as net.Socket;
            },
          },
        },
      });

      try {
        node.subscribe((event) => {
          if (event.type !== "HANDSHAKE_DEBUG") return;
          debugEvents.push({
            phase: event.phase,
            message: event.message,
          });
        });

        await expect(
          node.connections.connectPeer06("9.8.7.6", 6346),
        ).rejects.toThrow(
          'blocked client signature="Foxy/2.0" ip=9.8.7.6',
        );

        expect(node.getBlockedIps()).toEqual(["9.8.7.6"]);
        expect(debugEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              phase: "blocked-client",
              message: 'blocked client signature="Foxy/2.0" ip=9.8.7.6',
            }),
            expect.objectContaining({
              phase: "failed",
              message: 'blocked client signature="Foxy/2.0" ip=9.8.7.6',
            }),
          ]),
        );
      } finally {
        await node.stop();
      }
    });
  });
});
