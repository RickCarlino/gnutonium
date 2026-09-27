import { describe, expect, test } from "bun:test";
import {
  filterBlockedPeerState,
  normalizePeerState,
  peerStateTargets,
  persistedConfigForRuntime,
  persistedDocForRuntime,
  persistedStateForDoc,
  rememberPeerInState,
  sortPeerStateEntries,
} from "../../../src/config";
import { createCacheState } from "../../../src/discovery/gwebcache/state";
import type { ConfigDoc, RuntimeConfig } from "../../../src/types";

function runtime(patch: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    listenHost: "0.0.0.0",
    listenPort: 6346,
    advertisedHost: "72.14.201.10",
    advertisedPort: 7777,
    blockedIps: ["66.132.55.12"],
    gwebCaches: createCacheState(["http://cache.example.com/gcache.php"]),
    ultrapeer: true,
    monitorIgnoreEvents: ["PONG"],
    nodeMode: "ultrapeer",
    dataDir: "/tmp/gnutella-data",
    downloadsDir: "/tmp/gnutella-data/downloads",
    incompleteDownloadsDir: "/tmp/gnutella-data/incomplete",
    downloadQueueSize: 6,
    downloadMaxActivePerHost: 2,
    downloadRetryLimit: 10,
    downloadRetryBackoffSec: 60,
    downloadIdleTimeoutMs: 60000,
    verifyDownloads: true,
    peerSeenThresholdSec: 60,
    maxConnections: 12,
    maxUltrapeerConnections: 4,
    maxLeafConnections: 8,
    connectTimeoutMs: 1000,
    pingIntervalSec: 30,
    reconnectIntervalSec: 60,
    rescanSharesSec: 300,
    routeTtlSec: 600,
    seenTtlSec: 300,
    maxPayloadBytes: 65536,
    maxTtl: 7,
    defaultPingTtl: 5,
    defaultQueryTtl: 4,
    advertisedSpeedKBps: 1024,
    downloadTimeoutMs: 1000,
    pushWaitMs: 1000,
    maxResultsPerQuery: 32,
    userAgent: "GnutellaTest/0.1",
    queryRoutingVersion: "0.2",
    enableCompression: true,
    enableQrp: true,
    enableBye: true,
    enablePongCaching: true,
    enableGgep: true,
    enableTls: true,
    serveUriRes: true,
    vendorCode: "TEST",
    ...patch,
  };
}

function doc(patch: Partial<ConfigDoc["state"]> = {}): ConfigDoc {
  return {
    config: {
      listenHost: "0.0.0.0",
      listenPort: 6346,
      blockedIps: [],
      ultrapeer: false,
      maxUltrapeerConnections: 4,
      maxLeafConnections: 8,
      dataDir: "/tmp/gnutella-data",
    },
    state: {
      serventIdHex: "AA".repeat(16),
      peers: {
        "72.14.201.10:6346": 20,
        "66.132.55.12:6346": 10,
      },
      ...patch,
    },
  };
}

describe("persistence peer state", () => {
  test("normalizes peer maps and keeps the newest duplicate timestamp", () => {
    expect(
      normalizePeerState({
        "72.14.201.10:6346": 10.7,
        " 72.14.201.10:6346 ": 15,
        "66.132.55.12:6346": "bad",
        "66.132.55.12:70000": 1,
        garbage: 5,
      }),
    ).toEqual({
      "72.14.201.10:6346": 15,
      "66.132.55.12:6346": 0,
    });
  });

  test("remembers peers by promotion only when timestamps improve", () => {
    expect(
      rememberPeerInState(
        {
          "72.14.201.10:6346": 20,
          "66.132.55.12:6346": 10,
        },
        "66.132.55.12:6346",
        5,
      ),
    ).toEqual({
      "72.14.201.10:6346": 20,
      "66.132.55.12:6346": 10,
    });

    expect(
      rememberPeerInState(
        {
          "72.14.201.10:6346": 20,
          "66.132.55.12:6346": 10,
        },
        "66.132.55.12:6346",
        30,
      ),
    ).toEqual({
      "66.132.55.12:6346": 30,
      "72.14.201.10:6346": 20,
    });
  });

  test("filters blocked peers and ranks targets by last seen timestamp", () => {
    const peers = {
      "72.14.201.10:6346": 20,
      "66.132.55.12:6346": 30,
      "9.8.7.6:6346": 0,
    };

    expect(filterBlockedPeerState(peers, ["66.132.55.12"])).toEqual({
      "72.14.201.10:6346": 20,
      "9.8.7.6:6346": 0,
    });
    expect(peerStateTargets(peers)).toEqual([
      "66.132.55.12:6346",
      "72.14.201.10:6346",
      "9.8.7.6:6346",
    ]);
    expect(sortPeerStateEntries(peers)).toEqual([
      ["66.132.55.12:6346", 30],
      ["72.14.201.10:6346", 20],
      ["9.8.7.6:6346", 0],
    ]);
  });
});

describe("persistence document builders", () => {
  test("serializes runtime config to persisted snake-case fields", () => {
    expect(persistedConfigForRuntime(runtime())).toEqual({
      listen_ip: "0.0.0.0",
      listen_port: 6346,
      advertised_ip: "72.14.201.10",
      advertised_port: 7777,
      blocked_ips: ["66.132.55.12"],
      gwebcaches: createCacheState(["http://cache.example.com/gcache.php"])
        .entries,
      ultrapeer: true,
      max_ultrapeer_connections: 4,
      max_leaf_connections: 8,
      max_ttl: 7,
      enable_tls: true,
      log_ignore: ["PONG"],
      data_dir: "/tmp/gnutella-data",
      downloads_dir: "/tmp/gnutella-data/downloads",
      incomplete_downloads_dir: "/tmp/gnutella-data/incomplete",
      download_queue_size: 6,
      download_max_active_per_host: 2,
      download_retry_limit: 10,
      download_retry_backoff_sec: 60,
      download_idle_timeout_ms: 60000,
      verify_downloads: true,
    });
  });

  test("serializes persisted state with canonical IDs and ranked peers", () => {
    expect(persistedStateForDoc(doc(), "11".repeat(16))).toEqual({
      servent_id_hex: "aa".repeat(16),
      peers: {
        "72.14.201.10:6346": 20,
        "66.132.55.12:6346": 10,
      },
    });

    expect(
      persistedStateForDoc(
        doc({ serventIdHex: "invalid" }),
        "11".repeat(16),
      ),
    ).toEqual({
      servent_id_hex: "11".repeat(16),
      peers: {
        "72.14.201.10:6346": 20,
        "66.132.55.12:6346": 10,
      },
    });
  });

  test("builds a persisted document without filesystem access", () => {
    expect(
      persistedDocForRuntime(
        runtime({ advertisedPort: 6346, blockedIps: [] }),
        doc(),
        "11".repeat(16),
      ),
    ).toEqual({
      config: {
        listen_ip: "0.0.0.0",
        listen_port: 6346,
        advertised_ip: "72.14.201.10",
        gwebcaches: createCacheState([
          "http://cache.example.com/gcache.php",
        ]).entries,
        ultrapeer: true,
        max_ultrapeer_connections: 4,
        max_leaf_connections: 8,
        max_ttl: 7,
        enable_tls: true,
        log_ignore: ["PONG"],
        data_dir: "/tmp/gnutella-data",
        downloads_dir: "/tmp/gnutella-data/downloads",
        incomplete_downloads_dir: "/tmp/gnutella-data/incomplete",
        download_queue_size: 6,
        download_max_active_per_host: 2,
        download_retry_limit: 10,
        download_retry_backoff_sec: 60,
        download_idle_timeout_ms: 60000,
        verify_downloads: true,
      },
      state: {
        servent_id_hex: "aa".repeat(16),
        peers: {
          "72.14.201.10:6346": 20,
          "66.132.55.12:6346": 10,
        },
      },
    });
  });
});
