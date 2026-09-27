export const HEADER_LEN = 23;
export const LOCAL_ROUTE = "__local__";
export const DEFAULT_LISTEN_HOST = "0.0.0.0";
export const DEFAULT_LISTEN_PORT_MIN = 20000;
export const DEFAULT_LISTEN_PORT_MAX = 29999;
export const DEFAULT_USER_AGENT = "Gnutonium/2.0.0";
export const DEFAULT_VENDOR_CODE = "NIUM";
export const DATA_DOWNLOADS_DIRNAME = "downloads";
export const DATA_INCOMPLETE_DOWNLOADS_DIRNAME = "incomplete";
export const DATA_DOWNLOADS_STATE_FILENAME = "downloads.json";
export const DOWNLOAD_QUEUE_SIZE = 6;
export const DOWNLOAD_MAX_ACTIVE_PER_HOST = 2;
export const DOWNLOAD_RETRY_LIMIT = 10;
export const DOWNLOAD_RETRY_BACKOFF_SEC = 60;
export const VERIFY_DOWNLOADS = true;
export const MAX_ULTRAPEER_CONNECTIONS = 64;
export const MAX_LEAF_CONNECTIONS = 64;
export const CONNECT_TIMEOUT_MS = 5000;
export const PING_INTERVAL_SEC = 60;
export const RECONNECT_INTERVAL_SEC = 15;
export const RESCAN_SHARES_SEC = 30;
export const ROUTE_TTL_SEC = 600;
export const SEEN_TTL_SEC = 600;
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_TTL = 4;
export const DEFAULT_PING_TTL = 1;
export const DEFAULT_QUERY_TTL = 4;
export const ADVERTISED_SPEED_KBPS = 512;
export const DOWNLOAD_TIMEOUT_MS = 15000;
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
export const PUSH_WAIT_MS = 15000;
export const MAX_RESULTS_PER_QUERY = 50;
export const MAX_TRACKED_PEERS = 40;
export const PEER_SEEN_THRESHOLD_SEC = 60;
export const MAX_PEER_AGE_SEC = 7 * 24 * 60 * 60;
export const GWEBCACHE_REPORT_DELAY_SEC = 60 * 60;
export const DEFAULT_QUERY_ROUTING_VERSION = "0.2";
export const ENABLE_COMPRESSION = true;
export const ENABLE_TLS = true;
export const ENABLE_QRP = true;
export const ENABLE_BYE = true;
export const ENABLE_PONG_CACHING = true;
export const ENABLE_GGEP = true;
export const SERVE_URI_RES = true;
export const MAX_XTRY = 10;
export const BYE_DEFAULT_CODE = 200;
export const BOOTSTRAP_CONNECT_CONCURRENCY = 8;
export const BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR = 2;

export const TYPE = {
  PING: 0x00,
  PONG: 0x01,
  BYE: 0x02,
  ROUTE_TABLE_UPDATE: 0x30,
  PUSH: 0x40,
  QUERY: 0x80,
  QUERY_HIT: 0x81,
} as const;

export const TYPE_NAME: Record<number, string> = {
  [TYPE.PING]: "PING",
  [TYPE.PONG]: "PONG",
  [TYPE.BYE]: "BYE",
  [TYPE.ROUTE_TABLE_UPDATE]: "ROUTE_TABLE_UPDATE",
  [TYPE.PUSH]: "PUSH",
  [TYPE.QUERY]: "QUERY",
  [TYPE.QUERY_HIT]: "QUERY_HIT",
};

export const CANONICAL_HEADER_NAMES: Record<string, string> = {
  "user-agent": "User-Agent",
  "x-ultrapeer": "X-Ultrapeer",
  "x-ultrapeer-needed": "X-Ultrapeer-Needed",
  "x-query-routing": "X-Query-Routing",
  "x-ultrapeer-query-routing": "X-Ultrapeer-Query-Routing",
  "x-dynamic-querying": "X-Dynamic-Querying",
  "x-ext-probes": "X-Ext-Probes",
  "x-degree": "X-Degree",
  "accept-encoding": "Accept-Encoding",
  connection: "Connection",
  "content-encoding": "Content-Encoding",
  upgrade: "Upgrade",
  "listen-ip": "Listen-IP",
  "remote-ip": "Remote-IP",
  "pong-caching": "Pong-Caching",
  ggep: "GGEP",
  "bye-packet": "Bye-Packet",
  "x-try": "X-Try",
  "x-try-ultrapeers": "X-Try-Ultrapeers",
  "x-max-ttl": "X-Max-TTL",
  "private-data": "Private-Data",
};

export const INTERESTING_HANDSHAKE_HEADERS = [
  "server",
  "user-agent",
  "x-try",
  "x-try-ultrapeers",
  "x-ultrapeer",
  "x-ultrapeer-needed",
  "x-dynamic-querying",
  "x-ext-probes",
  "x-degree",
  "upgrade",
  "connection",
  "listen-ip",
  "remote-ip",
] as const;

export const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const PROMPT_THROBBER_FRAMES = ["*", "o", ".", " "] as const;
export const PROMPT_THROBBER_INTERVAL_MS = 120;
export const CLI_SHUTDOWN_TIMEOUT_MS = 3000;
