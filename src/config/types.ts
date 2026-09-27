export type PersistedConfig = {
  listen_ip?: unknown;
  listen_host?: unknown;
  listen_port?: unknown;
  advertised_ip?: unknown;
  advertised_host?: unknown;
  advertised_port?: unknown;
  blocked_ips?: unknown;
  gwebcaches?: unknown;
  gwebcache_urls?: unknown;
  ultrapeer?: unknown;
  max_connections?: unknown;
  max_ultrapeer_connections?: unknown;
  max_leaf_connections?: unknown;
  max_ttl?: unknown;
  enable_tls?: unknown;
  log_ignore?: unknown;
  data_dir?: unknown;
  downloads_dir?: unknown;
  incomplete_downloads_dir?: unknown;
  download_queue_size?: unknown;
  download_max_active_per_host?: unknown;
  download_retry_limit?: unknown;
  download_retry_backoff_sec?: unknown;
  download_idle_timeout_ms?: unknown;
  verify_downloads?: unknown;
};

export type PersistedState = {
  servent_id_hex?: unknown;
  peers?: unknown;
  gwebcaches?: unknown;
  gwebcache_next_request_at?: unknown;
};

export type PersistedDoc = {
  config?: PersistedConfig;
  state?: PersistedState;
};
