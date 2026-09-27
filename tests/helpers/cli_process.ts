import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { TYPE } from "../../src/const";
import { createCacheState } from "../../src/discovery/gwebcache/state";
import { defaultDoc, writeDoc } from "../../src/protocol";
import { buildHeader, encodeQueryHit } from "../../src/wire/codec";
import { makeShare } from "./protocol";

/** A localhost-only browse/transfer/cache fixture. Download responses deliberately remain pending. */
export async function cliServer() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\r\n\r\n")) return;
      if (input.startsWith("GET / HTTP/")) {
        const payload = encodeQueryHit(
          port,
          "127.0.0.1",
          100,
          [1, 2, 3].map((n) =>
            makeShare(n, `/fixture/file${n}.txt`, `file${n}.txt`),
          ),
          Buffer.alloc(16, 5),
        );
        const body = buildHeader(
          Buffer.alloc(16),
          TYPE.QUERY_HIT,
          1,
          0,
          payload,
        );
        socket.end(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 200 OK\r\nContent-Type: application/x-gnutella-packets\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
            ),
            body,
          ]),
        );
      } else if (!input.startsWith("GET /get/"))
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing server port");
  const port = address.port;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
export async function cliConfig(dir: string, cachePort: number) {
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  const doc = defaultDoc(configPath);
  doc.config.dataDir = dir;
  doc.config.ultrapeer = true;
  doc.config.listenHost = "127.0.0.1";
  doc.config.listenPort = await freePort();
  doc.config.advertisedHost = "127.0.0.1";
  doc.config.advertisedPort = doc.config.listenPort;
  doc.config.gwebCaches = createCacheState([
    `http://127.0.0.1:${cachePort}/cache`,
  ]);
  doc.state.peers = {};
  await writeDoc(configPath, doc);
  return { configPath, doc };
}
export function cliInvocation(configPath: string): string[] {
  const binary = process.env.GNUTONIUM_CLI_BINARY;
  return [
    ...(binary ? [binary] : [process.execPath, "run", "bin/gnutonium.ts"]),
    "run",
    "--config",
    configPath,
  ];
}
