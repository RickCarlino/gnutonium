import { readCacheState } from "../discovery/gwebcache/state";
import type { ConfigDoc, RuntimeConfig } from "../types";
import { trimPeerState } from "./peer_state";
import type {
  PersistedConfig,
  PersistedDoc,
  PersistedState,
} from "./types";

/** Convert runtime settings to the on-disk schema. */
export function persistedConfigForRuntime(
  runtime: RuntimeConfig,
): PersistedConfig {
  const cleanConfig: PersistedConfig = {
    listen_ip: runtime.listenHost,
    listen_port: runtime.listenPort,
    gwebcaches: readCacheState(runtime.gwebCaches.entries).entries,
    ultrapeer: runtime.ultrapeer,
    max_ultrapeer_connections: runtime.maxUltrapeerConnections,
    max_leaf_connections: runtime.maxLeafConnections,
    max_ttl: runtime.maxTtl,
    enable_tls: runtime.enableTls,
    data_dir: runtime.dataDir,
    downloads_dir: runtime.downloadsDir,
    incomplete_downloads_dir: runtime.incompleteDownloadsDir,
    download_queue_size: runtime.downloadQueueSize,
    download_max_active_per_host: runtime.downloadMaxActivePerHost,
    download_retry_limit: runtime.downloadRetryLimit,
    download_retry_backoff_sec: runtime.downloadRetryBackoffSec,
    download_idle_timeout_ms: runtime.downloadIdleTimeoutMs,
    verify_downloads: runtime.verifyDownloads,
  };
  if (runtime.advertisedHost)
    cleanConfig.advertised_ip = runtime.advertisedHost;
  if (
    runtime.advertisedPort != null &&
    runtime.advertisedPort !== runtime.listenPort
  ) {
    cleanConfig.advertised_port = runtime.advertisedPort;
  }
  if (runtime.blockedIps.length)
    cleanConfig.blocked_ips = runtime.blockedIps;
  if (runtime.monitorIgnoreEvents.length)
    cleanConfig.log_ignore = runtime.monitorIgnoreEvents;
  return cleanConfig;
}

/** Normalize the saved identity and remembered peers. */
export function persistedStateForDoc(
  doc: ConfigDoc,
  fallbackServentIdHex: string,
): PersistedState {
  return {
    servent_id_hex:
      typeof doc.state.serventIdHex === "string" &&
      /^[0-9a-f]{32}$/i.test(doc.state.serventIdHex)
        ? doc.state.serventIdHex.toLowerCase()
        : fallbackServentIdHex,
    peers: trimPeerState(doc.state.peers),
  };
}

/** Build the on-disk configuration and state document. */
export function persistedDocForRuntime(
  runtime: RuntimeConfig,
  doc: ConfigDoc,
  fallbackServentIdHex: string,
): PersistedDoc {
  return {
    config: persistedConfigForRuntime(runtime),
    state: persistedStateForDoc(doc, fallbackServentIdHex),
  };
}
