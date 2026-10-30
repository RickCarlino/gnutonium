import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { sleep } from "../../../src/shared";
import {
  makeNode,
  makeShare,
  MockSocket,
  withTempDir,
} from "../../helpers/protocol";

test("retries data arriving while an incomplete request's drain is still busy", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(path.join(dir, "config.json"));
    await fs.mkdir(node.config().downloadsDir, { recursive: true });
    const share = makeShare(
      1,
      path.join(node.config().downloadsDir, "alpha.txt"),
      "alpha.txt",
    );
    await fs.writeFile(share.abs, "hello");
    node.shareLibrary.sharesByIndex.set(share.index, share);
    const socket = new MockSocket();
    const head = "HEAD /get/1/alpha.txt HTTP/1.1\r\n";
    try {
      node.transfers.startHttpSession(
        socket as never,
        `${head}Content-Length: 4\r\n\r\n`,
        Buffer.from("a"),
      );
      // Arrive before the async drain's continuation releases its busy flag.
      socket.emit(
        "data",
        Buffer.from(`bcd${head}Connection: close\r\n\r\n`),
      );
      await sleep(20);
      expect(
        Buffer.concat(socket.writes)
          .toString()
          .match(/200 OK/g),
      ).toHaveLength(2);
      expect(socket.ended).toBe(true);
    } finally {
      await node.stop();
    }
  });
});
