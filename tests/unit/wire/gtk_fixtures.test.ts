import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { buildPeerCapabilities } from "../../../src/connections/policy";
import { parseHandshakeBlock } from "../../../src/wire/handshake";
import { withFakeNet } from "../../helpers/fake_net";
import { makeNode, withTempDir } from "../../helpers/protocol";

const fixtures = path.resolve(__dirname, "../../fixtures/gtk-1.3.1");

test("parses an independently recorded GTK TLS/compression response", async () => {
  const raw = await fs.readFile(
    path.join(fixtures, "tls-upgrade-response.bin"),
    "latin1",
  );
  const parsed = parseHandshakeBlock(raw);
  expect(parsed.startLine).toBe("GNUTELLA/0.6 200 OK");
  expect(parsed.headers["upgrade"]).toBe("TLS/1.0");
  expect(parsed.headers["content-encoding"]).toBe("deflate");
  expect(parsed.headers["x-query-routing"]).toBe("0.2");
  expect(parsed.headers["x-degree"]).toBe("46");
});

test("ingests GTK's recorded compressed, chunked browse response", async () => {
  await withFakeNet(async () => {
    await withTempDir(async (dir) => {
      const response = await fs.readFile(
        path.join(fixtures, "browse-response.bin"),
      );
      const server = net.createServer((socket) => {
        socket.once("data", () => socket.end(response));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as net.AddressInfo;
      const node = makeNode(path.join(dir, "config.json"), {
        runtimeConfig: { listenHost: "127.0.0.1" },
      });
      try {
        const count = await node.browsePeer(`127.0.0.1:${address.port}`);
        expect(count.resultCount).toBe(1);
        expect(node.getResults(count.id)[0]).toMatchObject({
          fileName: "gtk-interop-sample.txt",
          fileSize: 184320,
          vendorCode: "GTKG",
        });
        expect(node.getResults(count.id)[0]?.sha1Urn).toMatch(
          /^urn:sha1:/,
        );
      } finally {
        await node.stop();
      }
    });
  });
});

test("GTK Node header identifies the listening endpoint for inbound browsing", async () => {
  const raw = await fs.readFile(
    path.join(fixtures, "inbound-connect.bin"),
    "latin1",
  );
  const { headers } = parseHandshakeBlock(raw);
  const capabilities = buildPeerCapabilities({
    headers,
    version: "0.6",
    tlsEnabled: false,
    tlsUpgradeToken: "TLS/1.0",
    compressIn: false,
    compressOut: false,
  });
  expect(capabilities.listenIp).toEqual({
    host: "10.44.0.2",
    port: 16346,
  });
});
