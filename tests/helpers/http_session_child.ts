import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeNode, makeShare } from "./protocol";

async function main(): Promise<void> {
  // Run dangerous requests in a child so an event-loop regression cannot hang tests.
  const [dir, scenario] = process.argv.slice(2);
  const node = makeNode(path.join(dir, "config.json"));
  await fs.mkdir(node.config().downloadsDir, { recursive: true });
  const share = makeShare(
    1,
    path.join(node.config().downloadsDir, "alpha.txt"),
    "alpha.txt",
  );
  await fs.writeFile(share.abs, "hello");
  node.shareLibrary.sharesByIndex.set(share.index, share);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    node.connections.handleProbe(socket);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = net.createConnection({
    host: "127.0.0.1",
    port: address.port,
  });
  let response = "";
  let closed = false;
  client.on("data", (chunk) => {
    response += chunk.toString("latin1");
  });
  client.on("close", () => {
    closed = true;
  });
  client.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "ECONNRESET") throw error;
  });
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const head = "HEAD /get/1/alpha.txt HTTP/1.1\r\n";
  const responseCount = () =>
    response.match(/HTTP\/1\.1 200 OK/g)?.length ?? 0;
  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await delay(5);
    }
    assert.fail(`condition not reached: ${response}`);
  }
  try {
    const later = !scenario.endsWith("first");
    const pipelined = scenario === "incomplete-pipelined";
    const initialResponses = Number(later);
    if (later && !pipelined) {
      client.write(`${head}\r\n`);
      await waitFor(() => responseCount() === 1);
    }
    if (scenario.startsWith("oversized")) {
      client.write(`${head}X-Padding: ${"x".repeat(64 * 1024)}`);
      await waitFor(() => closed);
    } else if (scenario.startsWith("malformed")) {
      client.write(`${head}Content-Length: invalid\r\n\r\n`);
      await waitFor(() => closed);
      // Give a deferred, unhandled socket error a chance to terminate the child.
      await delay(20);
    } else {
      client.write(
        `${pipelined ? `${head}\r\n` : ""}${head}Content-Length: 4\r\n\r\na`,
      );
      await delay(30);
      assert.equal(responseCount(), initialResponses);
      assert.equal(closed, false);
      client.write(`b`);
      await delay(20);
      assert.equal(responseCount(), initialResponses);
      client.write(`cd${head}Connection: close\r\n\r\n`);
      await waitFor(() => closed);
      assert.equal(responseCount(), initialResponses + 2);
    }
  } finally {
    client.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await node.stop();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
