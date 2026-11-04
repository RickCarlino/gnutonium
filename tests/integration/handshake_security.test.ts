import { expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import { MAX_HEADER_BYTES } from "../../src/const";
import { makeNode, makeShare, withTempDir } from "../helpers/protocol";

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as net.AddressInfo).port;
}

async function probe(
  port: number,
  payload: string,
  trickle = false,
): Promise<string> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  let response = "";
  let interval: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error("probe did not close")),
        2000,
      );
      socket.once("connect", () => {
        socket.write(payload);
        if (trickle) interval = setInterval(() => socket.write("x"), 10);
      });
      socket.on("data", (chunk) => {
        response += chunk.toString();
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
      socket.once("close", () => resolve(response));
    });
  } finally {
    clearTimeout(deadline);
    clearInterval(interval);
    socket.destroy();
  }
}

test.each([
  ["GNUTELLA CONNECT/0.6\r\nX-Padding: ", false],
  ["GIV 1:00112233445566778899aabbccddeeff/name\nX-Padding: ", false],
  [
    "GNUTELLA CONNECT/0.6\r\nX-Ultrapeer: true\r\n\r\nGNUTELLA/0.6 200 OK\r\nX-Padding: ",
    false,
  ],
  ["GNUTELLA CONNECT/0.6\r\nX-Padding: ", true],
] as const)(
  "TCP probe bounds headers and lifetime: %s trickle=%s",
  async (prefix, trickle) => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "config.json"), {
        runtimeConfig: { enableTls: false, connectTimeoutMs: 100 },
      });
      const sockets = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        node.connections.handleProbe(socket);
      });
      try {
        const port = await listen(server);
        await probe(
          port,
          `${prefix}${trickle ? "" : "x".repeat(MAX_HEADER_BYTES + 1)}`,
          trickle,
        );
        expect(node.getPeers()).toHaveLength(0);
        // Rejection leaves the listener able to handle another protocol.
        expect(
          await probe(port, "GET /missing HTTP/1.0\r\n\r\n"),
        ).toContain("400 Bad Request");
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        await node.stop();
      }
    });
  },
);

test.each([false, true])(
  "LAN push callback bounds headers; trickle=%s",
  async (trickle) => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "config.json"), {
        runtimeConfig: { downloadTimeoutMs: 100 },
      });
      node.shareLibrary.sharesByIndex.set(
        1,
        makeShare(1, path.join(dir, "share.txt"), "share.txt"),
      );
      let accepted!: () => void;
      const closed = new Promise<void>((resolve) => {
        accepted = resolve;
      });
      let interval: ReturnType<typeof setInterval> | undefined;
      const sockets = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", accepted);
        socket.once("data", (data) => {
          expect(data.toString()).toContain("GIV 1:");
          socket.write("GET /missing HTTP/1.1\r\nX-Padding: ");
          if (trickle) interval = setInterval(() => socket.write("x"), 10);
          else socket.write("x".repeat(MAX_HEADER_BYTES));
        });
      });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const port = await listen(server);
        await node.transfers.fulfillPush(
          {
            serventId: Buffer.from(node.getServentIdHex(), "hex"),
            serventIdHex: node.getServentIdHex(),
            fileIndex: 1,
            ip: "127.0.0.1",
            port,
            ggep: Buffer.alloc(0),
          },
          "127.0.0.1",
        );
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("push callback did not close")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        clearInterval(interval);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        await node.stop();
      }
    });
  },
);
