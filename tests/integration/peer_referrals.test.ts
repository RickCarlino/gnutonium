import { expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import { TYPE } from "../../src/const";
import { connectBootstrapPeers } from "../../src/gwebcache_client";
import { loadDoc } from "../../src/protocol";
import { buildHeader, encodePong } from "../../src/wire/codec";
import { buildHandshakeBlock } from "../../src/wire/handshake";
import { withFakeNet } from "../helpers/fake_net";
import { makeNode, withTempDir } from "../helpers/protocol";

test.each(["200 OK", "503 Busy"])(
  "public peer referrals never become private automatic dials after %s",
  async (status) => {
    // In-memory sockets give the peer a public remoteAddress without using
    // the Internet, while exercising the complete handshake and dial paths.
    await withFakeNet(async () => {
      await withTempDir(async (dir) => {
        const sockets = new Set<net.Socket>();
        const server = net.createServer((socket) => {
          sockets.add(socket);
          socket.once("data", () => {
            const headers = buildHandshakeBlock(`GNUTELLA/0.6 ${status}`, {
              "user-agent": "TestPeer/1.0",
              "x-ultrapeer": "True",
              "x-try": "192.168.1.1:6567,8.8.4.4:6346",
              "x-try-ultrapeers": "127.0.0.2:6346,1.1.1.1:6346",
              "listen-ip": "10.0.0.1:6346",
              "remote-ip": "127.0.0.1",
            });
            if (status !== "200 OK") {
              socket.end(headers);
              return;
            }
            const pong = buildHeader(
              Buffer.alloc(16),
              TYPE.PONG,
              1,
              0,
              encodePong(6346, "172.16.0.1", 0, 0),
            );
            socket.write(Buffer.concat([headers, pong]));
          });
        });
        await new Promise<void>((resolve) =>
          server.listen(6346, "8.8.8.8", resolve),
        );
        const attempts: string[] = [];
        const configPath = path.join(dir, "config.json");
        const node = makeNode(configPath, {
          runtimeConfig: { enableCompression: false, enableBye: false },
          collaborators: {
            netFactory: {
              createConnection: (options) => {
                if ("host" in options && "port" in options)
                  attempts.push(`${options.host}:${options.port}`);
                return net.createConnection(options);
              },
            },
            bootstrapClient: {
              connectBootstrapPeers: (options) =>
                connectBootstrapPeers({
                  ...options,
                  caches: [],
                  fetchImpl: async () =>
                    new Response("I|pong|Test|gnutella\n"),
                }),
            },
          },
        });
        try {
          const result = await node.connectToPeer("8.8.8.8:6346");
          expect(result.status).toBe(
            status === "200 OK" ? "connected" : "saved",
          );
          expect(node.getKnownPeers().sort()).toEqual([
            "1.1.1.1:6346",
            "8.8.4.4:6346",
            "8.8.8.8:6346",
          ]);
          expect(node.router.pongCache.size).toBe(0);
          await node.save();
          expect(
            Object.keys((await loadDoc(configPath)).state.peers).sort(),
          ).toEqual(node.getKnownPeers().sort());
          await node.discovery.connectKnownPeers();
          expect(attempts).toContain("1.1.1.1:6346");
          expect(attempts).toContain("8.8.4.4:6346");
          expect(new Set(attempts)).toEqual(
            new Set(["8.8.8.8:6346", "1.1.1.1:6346", "8.8.4.4:6346"]),
          );
          // A deliberate LAN connection still reaches the network factory.
          await node.connectToPeer("192.168.1.2:6346");
          expect(attempts).toContain("192.168.1.2:6346");
        } finally {
          for (const socket of sockets) socket.destroy();
          await node.stop();
          await new Promise<void>((resolve) =>
            server.close(() => resolve()),
          );
        }
      });
    });
  },
);
