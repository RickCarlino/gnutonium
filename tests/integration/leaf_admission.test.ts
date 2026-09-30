import { expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import {
  buildHandshakeBlock,
  findHeaderEnd,
  parseHandshakeBlock,
} from "../../src/wire/handshake";
import { makeNode, withTempDir } from "../helpers/protocol";

// Admission conditions from LimeWire Pirate Edition's HandshakeResponse.java:
// https://github.com/metapirate/LimeWire-Pirate-Edition/blob/master/components/gnutella-core/src/main/java/com/limegroup/gnutella/handshaking/HandshakeResponse.java
function modernConnection(headers: Record<string, string>): boolean {
  return (
    Number(headers["x-degree"] ?? 6) >= 15 &&
    Number(headers["x-ultrapeer-query-routing"] ?? 0) >= 0.1 &&
    Number(headers["x-max-ttl"] ?? 4) < 5 &&
    Number(headers["x-dynamic-querying"] ?? 0) >= 0.1
  );
}

function goodLeaf(headers: Record<string, string>): boolean {
  return (
    modernConnection(headers) &&
    (headers["user-agent"]?.toLowerCase().startsWith("limewire") ||
      headers["x-requeries"]?.toLowerCase() === "false")
  );
}

test.each([true, false])(
  "leaf admission over TCP with QRP enabled=%s",
  async (enableQrp) => {
    await withTempDir(async (dir) => {
      const sockets = new Set<net.Socket>();
      const requests: ReturnType<typeof parseHandshakeBlock>[] = [];
      let finalReceived = () => {};
      const final = new Promise<void>((resolve) => {
        finalReceived = resolve;
      });
      const server = net.createServer((socket) => {
        sockets.add(socket);
        let buffer = "";
        let stage = 0;
        socket.on("data", (data) => {
          if (stage >= 2) return;
          buffer += data.toString("latin1");
          const end = findHeaderEnd(buffer);
          if (end < 0) return;
          const request = parseHandshakeBlock(buffer.slice(0, end));
          buffer = buffer.slice(end);
          requests.push(request);
          if (stage++ > 0) {
            finalReceived();
            return;
          }
          if (!goodLeaf(request.headers)) {
            socket.end("GNUTELLA/0.6 503 Not Good Leaf\r\n\r\n");
            return;
          }
          socket.write(
            buildHandshakeBlock("GNUTELLA/0.6 200 OK", {
              "user-agent": "LimeWire/5.6.1",
              "x-ultrapeer": "True",
              "x-query-routing": "0.1",
            }),
          );
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const node = makeNode(path.join(dir, "config.json"), {
        runtimeConfig: {
          nodeMode: "leaf",
          advertisedHost: "127.0.0.1",
          maxUltrapeerConnections: 2,
          maxTtl: 7,
          enableQrp,
          enableCompression: false,
          enableBye: false,
        },
      });
      try {
        const port = (server.address() as net.AddressInfo).port;
        const connected = node.connections.connectPeer06(
          "127.0.0.1",
          port,
          1000,
        );
        if (enableQrp) {
          await connected;
          await final;
          expect(requests[1]!.startLine).toBe("GNUTELLA/0.6 200 OK");
          expect(node.getPeers()).toHaveLength(1);
          expect(node.getPeers()[0]!.role).toBe("ultrapeer");
          expect(node.connections.nodeMode()).toBe("leaf");
          expect(node.connections.shouldRelayQueries()).toBe(false);
          expect(requests[0]!.headers["x-query-routing"]).toBe("0.2");
        } else {
          await expect(connected).rejects.toThrow("503 Not Good Leaf");
          expect(node.getPeers()).toHaveLength(0);
        }
        expect(requests[0]!.startLine).toBe("GNUTELLA CONNECT/0.6");
        expect(requests[0]!.headers["x-ultrapeer"]).toBe("False");
        expect(requests[0]!.headers["user-agent"]).toStartWith(
          "Gnutonium/",
        );
      } finally {
        for (const socket of sockets) socket.destroy();
        await node.stop();
        await new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
      }
    });
  },
);
