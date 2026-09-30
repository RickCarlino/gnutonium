import { describe, expect, test } from "bun:test";
import {
  buildBaseHandshakeHeaders,
  buildClientFinalHeaders,
  buildHandshakeBlock,
  buildPeerCapabilities,
  buildRejectHeaders,
  buildServerHandshakeHeaders,
  describeHandshakeResponse,
  findHeaderEnd,
  parseBoolHeader,
  parseHandshakeBlock,
  parseListenIpHeader,
  parsePeerHeaderList,
  parsePositiveIntHeader,
  type LocalHandshakePolicy,
} from "../../../../src/connections/policy";

function localPolicy(
  patch: Partial<LocalHandshakePolicy> = {},
): LocalHandshakePolicy {
  return {
    userAgent: "Gnutonium/1.3.0",
    advertisedHost: "7.7.7.7",
    advertisedPort: 7777,
    maxTtl: 7,
    nodeMode: "leaf",
    maxUltrapeerConnections: 2,
    maxLeafConnections: 3,
    connectedMeshPeerCount: 0,
    connectedLeafCount: 0,
    enableQrp: true,
    queryRoutingVersion: "0.2",
    enableCompression: true,
    enablePongCaching: true,
    enableGgep: true,
    enableBye: true,
    tlsEnabled: true,
    tlsUpgradeToken: "TLS/1.0",
    ...patch,
  };
}

describe("handshake policy", () => {
  test("parses and renders canonical handshake headers", () => {
    const raw =
      "GNUTELLA/0.6 200 OK\r\n" +
      "User-Agent: Peer/1.0\r\n" +
      "X-Try: 1.1.1.1:1111\r\n" +
      "X-Try: 2.2.2.2:2222\r\n" +
      "Private-Data: alpha\r\n" +
      " beta\r\n\r\nbody";

    expect(findHeaderEnd(raw)).toBe(raw.indexOf("\r\n\r\n") + 4);
    expect(parseHandshakeBlock(raw)).toEqual({
      startLine: "GNUTELLA/0.6 200 OK",
      headers: {
        "user-agent": "Peer/1.0",
        "x-try": "1.1.1.1:1111,2.2.2.2:2222",
        "private-data": "alpha beta",
      },
    });

    expect(
      buildHandshakeBlock("GNUTELLA CONNECT/0.6", {
        "user-agent": "Peer/1.0",
        "x-ultrapeer": "True",
      }).toString("latin1"),
    ).toBe(
      "GNUTELLA CONNECT/0.6\r\n" +
        "User-Agent: Peer/1.0\r\n" +
        "X-Ultrapeer: True\r\n\r\n",
    );
    expect(
      describeHandshakeResponse("GNUTELLA/0.6 503 Busy", {
        "user-agent": "Peer/1.0",
        "x-try": "1.1.1.1:1111",
      }),
    ).toBe(
      "GNUTELLA/0.6 503 Busy [User-Agent=Peer/1.0; X-Try=1.1.1.1:1111]",
    );
  });

  test("builds leaf and ultrapeer local headers from structural state", () => {
    expect(buildBaseHandshakeHeaders(localPolicy())).toMatchObject({
      "user-agent": "Gnutonium/1.3.0",
      "listen-ip": "7.7.7.7:7777",
      "x-max-ttl": "4",
      "x-ultrapeer": "False",
      "x-query-routing": "0.2",
      "x-requeries": "False",
      "accept-encoding": "deflate",
      "pong-caching": "0.1",
      ggep: "0.5",
      "bye-packet": "0.1",
    });

    expect(
      buildBaseHandshakeHeaders(
        localPolicy({
          nodeMode: "ultrapeer",
          maxUltrapeerConnections: 4,
          connectedMeshPeerCount: 3,
        }),
      ),
    ).toMatchObject({
      "x-ultrapeer": "True",
      "x-ultrapeer-needed": "True",
      "x-ultrapeer-query-routing": "0.1",
      "x-dynamic-querying": "0.1",
      "x-ext-probes": "0.1",
      "x-degree": "16",
    });

    expect(
      buildBaseHandshakeHeaders(
        localPolicy({
          nodeMode: "ultrapeer",
          maxUltrapeerConnections: 4,
          maxLeafConnections: 2,
          connectedMeshPeerCount: 4,
          connectedLeafCount: 1,
        }),
      )["x-ultrapeer-needed"],
    ).toBe("False");

    expect(
      buildBaseHandshakeHeaders(
        localPolicy({
          nodeMode: "ultrapeer",
          maxUltrapeerConnections: 4,
          maxLeafConnections: 2,
          connectedMeshPeerCount: 4,
          connectedLeafCount: 2,
        }),
      )["x-ultrapeer-needed"],
    ).toBeUndefined();
  });

  test("leaf compatibility headers apply to requests and responses without changing role", () => {
    const policy = localPolicy({ maxUltrapeerConnections: 2 });
    for (const headers of [
      buildBaseHandshakeHeaders(policy),
      buildServerHandshakeHeaders(policy, {}),
    ]) {
      expect(headers).toMatchObject({
        "user-agent": "Gnutonium/1.3.0",
        "x-ultrapeer": "False",
        "x-query-routing": "0.2",
        "x-requeries": "False",
        "x-ultrapeer-query-routing": "0.1",
        "x-dynamic-querying": "0.1",
        "x-degree": "32",
        "x-max-ttl": "4",
      });
      expect(headers["x-ultrapeer-needed"]).toBeUndefined();
      expect(headers["x-ext-probes"]).toBeUndefined();
    }
    expect(
      buildBaseHandshakeHeaders(localPolicy({ maxTtl: 2 }))["x-max-ttl"],
    ).toBe("2");
    expect(
      buildBaseHandshakeHeaders(
        localPolicy({ nodeMode: "ultrapeer", maxTtl: 7 }),
      )["x-max-ttl"],
    ).toBe("7");
    const disabled = buildBaseHandshakeHeaders(
      localPolicy({ enableQrp: false }),
    );
    expect(disabled["x-query-routing"]).toBeUndefined();
    expect(disabled["x-ultrapeer-query-routing"]).toBeUndefined();
    expect(disabled["x-dynamic-querying"]).toBeUndefined();
    expect(disabled["x-degree"]).toBeUndefined();
  });

  test("negotiates compression, TLS, and remote IP headers", () => {
    expect(
      buildServerHandshakeHeaders(
        localPolicy(),
        {
          "accept-encoding": "gzip, deflate",
          upgrade: "TLS/1.0",
        },
        "::ffff:9.8.7.6",
      ),
    ).toMatchObject({
      "content-encoding": "deflate",
      upgrade: "TLS/1.0",
      connection: "Upgrade",
      "remote-ip": "9.8.7.6",
    });

    expect(
      buildClientFinalHeaders(
        localPolicy(),
        {
          "accept-encoding": "deflate",
          upgrade: "TLS/1.0",
          connection: "Upgrade",
        },
        "9.8.7.6, 1.1.1.1",
      ),
    ).toEqual({
      "remote-ip": "9.8.7.6",
      connection: "Upgrade",
      "content-encoding": "deflate",
    });

    expect(
      buildClientFinalHeaders(
        localPolicy({ tlsEnabled: false, enableCompression: false }),
        {
          "accept-encoding": "deflate",
          upgrade: "TLS/1.0",
          connection: "Upgrade",
        },
      ),
    ).toEqual({});
  });

  test("parses remote capability combinations", () => {
    const caps = buildPeerCapabilities({
      version: "0.6",
      headers: {
        "User-Agent": "Peer/1.0",
        "Accept-Encoding": "gzip, deflate",
        "Content-Encoding": "deflate",
        Upgrade: "TLS/1.0",
        "X-Ultrapeer": "True",
        "X-Ultrapeer-Needed": "false",
        "Listen-IP": "9.8.7.6:6346",
        "X-Query-Routing": "0.2",
        "X-Ultrapeer-Query-Routing": "0.1",
        "X-Dynamic-Querying": "0.1",
        "X-Ext-Probes": "0.1",
        "X-Degree": "32",
        GGEP: "0.5",
        "Pong-Caching": "0.1",
        "Bye-Packet": "0.1",
      },
      compressIn: true,
      compressOut: false,
      tlsEnabled: true,
      tlsUpgradeToken: "TLS/1.0",
    });

    expect(caps).toMatchObject({
      userAgent: "Peer/1.0",
      supportsGgep: true,
      supportsPongCaching: true,
      supportsBye: true,
      supportsTls: true,
      supportsCompression: true,
      compressIn: true,
      compressOut: false,
      isUltrapeer: true,
      ultrapeerNeeded: false,
      queryRoutingVersion: "0.2",
      ultrapeerQueryRoutingVersion: "0.1",
      dynamicQueryingVersion: "0.1",
      extProbesVersion: "0.1",
      degree: 32,
      listenIp: { host: "9.8.7.6", port: 6346 },
    });

    expect(parseBoolHeader("TRUE")).toBe(true);
    expect(parseBoolHeader("wat")).toBeUndefined();
    expect(parsePositiveIntHeader("12")).toBe(12);
    expect(parsePositiveIntHeader("0")).toBeUndefined();
    expect(parseListenIpHeader("1.2.3.4:6346")).toEqual({
      host: "1.2.3.4",
      port: 6346,
    });
  });

  test("builds reject headers and parses try peer lists", () => {
    expect(
      buildRejectHeaders({
        extraHeaders: { Server: "TestServent" },
        remoteIp: "::ffff:9.8.7.6",
        tryPeers: ["1.1.1.1:1111", "2.2.2.2:2222"],
      }),
    ).toEqual({
      server: "TestServent",
      "remote-ip": "9.8.7.6",
      "x-try": "1.1.1.1:1111,2.2.2.2:2222",
      "x-try-ultrapeers": "1.1.1.1:1111,2.2.2.2:2222",
    });

    expect(
      parsePeerHeaderList(
        "1.1.1.1:1111, invalid, 2.2.2.2:2222, 3.3.3.3:70000",
      ),
    ).toEqual([
      { host: "1.1.1.1", port: 1111 },
      { host: "2.2.2.2", port: 2222 },
    ]);
  });
});
