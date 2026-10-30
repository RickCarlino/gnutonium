import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { SearchHit } from "../../src/types";
import { makeNode, withTempDir } from "../helpers/protocol";

async function withServer(
  accept: (socket: net.Socket) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    accept(socket);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  try {
    await run((server.address() as net.AddressInfo).port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function request(port: number, target: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const client = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    client.setTimeout(2000, () =>
      client.destroy(new Error("request timeout")),
    );
    client.on("error", reject);
    client.on("connect", () =>
      client.write(`GET ${target} HTTP/1.1\r\nConnection: close\r\n\r\n`),
    );
    client.on("data", (chunk) => {
      response += chunk.toString();
    });
    client.on("close", () => resolve(response));
  });
}

test("HTTP traversal stays in the catalog and stale symlinks cannot disclose files", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(path.join(dir, "config.json"));
    const root = node.config().downloadsDir;
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "public.txt");
    const secret = path.join(dir, "secret.txt");
    await fs.writeFile(file, "PUBLIC");
    await fs.writeFile(secret, "PRIVATE SECRET");
    await node.refreshShares();
    await node.shareLibrary.shareHashTask;
    const share = node.getShares()[0]!;
    try {
      await withServer(
        (socket) => node.connections.handleProbe(socket),
        async (port) => {
          for (const name of [
            "../../secret.txt",
            "%2e%2e%2fsecret.txt",
            "..\\secret.txt",
          ]) {
            const response = await request(
              port,
              `/get/${share.index}/${name}`,
            );
            expect(response).toContain("PUBLIC");
            expect(response).not.toContain("PRIVATE SECRET");
          }
          await fs.unlink(file);
          await fs.symlink(secret, file);
          for (const target of [
            `/get/${share.index}/public.txt`,
            `/uri-res/N2R?${share.sha1Urn}`,
          ]) {
            expect(await request(port, target)).not.toContain(
              "PRIVATE SECRET",
            );
          }
          expect(await request(port, "/uri-res/N2R?%zz")).not.toContain(
            "PRIVATE SECRET",
          );
        },
      );
    } finally {
      await node.stop();
    }
  });
});

test("malicious HTTP responses cannot overwrite linked destinations or buffer unlimited headers", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(path.join(dir, "config.json"));
    const secret = path.join(dir, "secret");
    const dest = path.join(dir, "download");
    await fs.writeFile(secret, "PRIVATE");
    await fs.symlink(secret, dest);
    let oversized = false;
    try {
      await withServer(
        (socket) =>
          socket.once("data", () => {
            socket.write(
              oversized
                ? `HTTP/1.1 200 OK\r\nX-Padding: ${"x".repeat(65536)}`
                : "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nEVIL",
            );
          }),
        async (port) => {
          const hit: SearchHit = {
            resultNo: 1,
            queryIdHex: "aa".repeat(16),
            queryHops: 1,
            remoteHost: "127.0.0.1",
            remotePort: port,
            speedKBps: 1,
            fileIndex: 1,
            fileName: "../../secret",
            fileSize: 4,
            serventIdHex: "bb".repeat(16),
            viaPeerKey: "local",
          };
          await expect(
            node.transfers.directDownload(hit, dest),
          ).rejects.toThrow("regular");
          expect(await fs.readFile(secret, "utf8")).toBe("PRIVATE");
          oversized = true;
          const fresh = path.join(dir, "fresh");
          await expect(
            node.transfers.directDownload(hit, fresh),
          ).rejects.toThrow("headers too large");
          expect(await fs.exists(fresh)).toBe(false);
          const job = await node.downloadManager.queue(hit);
          expect(path.dirname(job.destPath)).toBe(
            rootPath(node.config().downloadsDir),
          );
          expect(path.dirname(job.incompletePath)).toBe(
            node.config().incompleteDownloadsDir,
          );
        },
      );
    } finally {
      await node.stop();
    }
  });
});

function rootPath(value: string): string {
  return path.resolve(value);
}
