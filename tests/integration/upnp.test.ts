import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { defaultDoc } from "../../src/config/document";
import { createCacheState } from "../../src/discovery/gwebcache/state";
import { createGateway } from "../../src/nat/gateway";
import { NatService } from "../../src/nat/service";
import { parseServices, requestXml, xmlValue } from "../../src/nat/soap";
import { GnutellaServent } from "../../src/protocol";
import { cliConfig } from "../helpers/cli_process";
import { withTempDir } from "../helpers/protocol";
import { fakeGateway } from "../helpers/upnp";

function handshake(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout(2000, () =>
      socket.destroy(new Error("Handshake timeout")),
    );
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(
        "GNUTELLA CONNECT/0.6\r\nUser-Agent: UPnP test\r\nX-Ultrapeer: True\r\n\r\n",
      ),
    );
    socket.on("data", (data) => {
      response += data.toString();
      if (!response.includes("\r\n\r\n")) return;
      socket.destroy();
      resolve(response);
    });
  });
}

async function client(router: ReturnType<typeof fakeGateway>) {
  const { xml } = await requestXml(router.url);
  return createGateway(
    parseServices(xml, {
      url: router.url,
      localAddress: "192.168.1.2",
    })[0],
  );
}

test("servent automatically maps through SOAP, exposes status and cleans up without persisting the endpoint", async () => {
  const router = fakeGateway();
  try {
    const gateway = await client(router);
    await withTempDir(async (dir) => {
      const fixture = await cliConfig(
        dir,
        Number(new URL(router.url).port),
      );
      const doc = defaultDoc(fixture.configPath);
      doc.config.dataDir = dir;
      doc.config.listenHost = "0.0.0.0";
      doc.config.listenPort = fixture.doc.config.listenPort;
      doc.config.gwebCaches = createCacheState([router.url]);
      doc.state.peers = {};
      const mapped = Promise.withResolvers<void>();
      const node = new GnutellaServent(fixture.configPath, doc, {
        collaborators: { nat: { discover: async () => [gateway] } },
        onEvent: (event) => {
          if (event.type === "NAT_STATUS" && event.state === "mapped")
            mapped.resolve();
        },
      });
      try {
        await node.start();
        await mapped.promise;
        expect(router.mapping()?.port).toBe(doc.config.listenPort);
        const add = router.requests.find(
          (r) => r.action === "AddPortMapping",
        )!;
        expect(xmlValue(add.body, "NewProtocol")).toBe("TCP");
        expect(xmlValue(add.body, "NewEnabled")).toBe("1");
        expect(xmlValue(add.body, "NewLeaseDuration")).toBe("3600");
        const headers = await handshake(doc.config.listenPort);
        expect(headers.toLowerCase()).toContain(
          `listen-ip: 44.55.66.77:${doc.config.listenPort}`,
        );
      } finally {
        await node.stop();
      }
      expect(router.mapping()).toBeUndefined();
      const persisted = await fs.readFile(
        path.join(dir, "config.json"),
        "utf8",
      );
      expect(persisted).not.toContain("44.55.66.77");
    });
  } finally {
    router.close();
  }
});

test("SOAP permanent-lease fallback and private WAN rejection work against a router fixture", async () => {
  const router = fakeGateway();
  const statuses: string[] = [];
  try {
    router.permanent();
    const gateway = await client(router);
    const service = new NatService({
      discover: async () => [gateway],
      scheduler: { setTimeout, clearTimeout },
      address: () => {},
      report: (status) => statuses.push(status.state),
    });
    try {
      await service.start({ listenHost: "0.0.0.0", listenPort: 6346 });
      expect(statuses).toEqual(["mapped"]);
      expect(
        router.requests
          .filter((r) => r.action === "AddPortMapping")
          .map((r) => xmlValue(r.body, "NewLeaseDuration")),
      ).toEqual(["3600", "0"]);
    } finally {
      await service.stop();
    }
    expect(router.mapping()).toBeUndefined();
    router.setAddress("100.64.1.2");
    await expect(gateway.externalAddress()).rejects.toThrow(
      "no public IPv4",
    );
  } finally {
    router.close();
  }
});

test("router HTTP reads reject redirects, oversized XML and malformed SOAP success", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "/large" },
        });
      return new Response(
        path === "/large" ? "x".repeat(300_000) : "not SOAP",
      );
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await expect(requestXml(`${base}/redirect`)).rejects.toThrow();
    await expect(requestXml(`${base}/large`)).rejects.toThrow("too large");
    const gateway = createGateway({
      url: base,
      controlUrl: base,
      localAddress: "192.168.1.2",
      serviceType: "urn:schemas-upnp-org:service:WANIPConnection:1",
    });
    await expect(gateway.add(6346, "test", 3600)).rejects.toThrow(
      "Invalid UPnP",
    );
  } finally {
    server.stop(true);
  }
});
