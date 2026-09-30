import { DEFAULT_USER_AGENT } from "../../const";
import type { PeerCapabilities } from "../../types";
import {
  hasToken,
  lowerCaseHeaders,
  parseBoolHeader,
  parseListenIpHeader,
  parsePositiveIntHeader,
  parseRemoteIpHeader,
} from "../../wire/handshake";
import type { CapabilityPolicy, LocalHandshakePolicy } from "./types";

const GTK_MODERN_ULTRAPEER_MIN_DEGREE = 16;

function ultrapeerNeededHeader(
  policy: LocalHandshakePolicy,
): string | undefined {
  if (policy.nodeMode !== "ultrapeer") return undefined;
  if (policy.connectedMeshPeerCount < policy.maxUltrapeerConnections)
    return "True";
  if (policy.connectedLeafCount < policy.maxLeafConnections)
    return "False";
  return undefined;
}

function baseRoleHeaders(
  policy: LocalHandshakePolicy,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ultrapeer": policy.nodeMode === "ultrapeer" ? "True" : "False",
  };
  const ultrapeerNeeded = ultrapeerNeededHeader(policy);
  if (ultrapeerNeeded) headers["x-ultrapeer-needed"] = ultrapeerNeeded;
  if (policy.nodeMode === "leaf" && policy.enableQrp) {
    // gtk-gnutella uses these compatibility values because LimeWire applies
    // ultrapeer capability checks to leaves too (nodes.c: node_init_outgoing).
    // X-Ultrapeer remains False; these do not enable forwarding in leaf mode.
    headers["x-ultrapeer-query-routing"] = "0.1";
    headers["x-dynamic-querying"] = "0.1";
    headers["x-degree"] = "32";
    headers["x-max-ttl"] = String(Math.min(policy.maxTtl, 4));
  }
  if (policy.nodeMode === "ultrapeer") {
    headers["x-ultrapeer-query-routing"] = "0.1";
    headers["x-dynamic-querying"] = "0.1";
    headers["x-ext-probes"] = "0.1";
    headers["x-degree"] = String(
      Math.max(
        GTK_MODERN_ULTRAPEER_MIN_DEGREE,
        policy.maxUltrapeerConnections,
      ),
    );
  }
  return headers;
}

function baseFeatureHeaders(
  policy: LocalHandshakePolicy,
): Record<string, string> {
  const headers: Record<string, string> = { "x-requeries": "False" };
  if (policy.enableQrp)
    headers["x-query-routing"] = policy.queryRoutingVersion || "0.1";
  if (policy.enableCompression) headers["accept-encoding"] = "deflate";
  if (policy.enablePongCaching) headers["pong-caching"] = "0.1";
  if (policy.enableGgep) headers.ggep = "0.5";
  if (policy.enableBye) headers["bye-packet"] = "0.1";
  return headers;
}

/** Advertise local identity, role, and supported features. */
export function buildBaseHandshakeHeaders(
  policy: LocalHandshakePolicy,
  remoteIp?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": policy.userAgent || DEFAULT_USER_AGENT,
    "listen-ip": `${policy.advertisedHost}:${policy.advertisedPort}`,
    "x-max-ttl": String(policy.maxTtl),
    ...baseRoleHeaders(policy),
    ...baseFeatureHeaders(policy),
  };
  const observedRemote = parseRemoteIpHeader(remoteIp);
  if (observedRemote) headers["remote-ip"] = observedRemote;
  return headers;
}

function peerRequestedTlsUpgrade(
  headers: Record<string, string>,
  upgradeToken: string,
): boolean {
  return hasToken(headers.upgrade, upgradeToken);
}

function peerAcceptedTlsUpgrade(
  headers: Record<string, string>,
  upgradeToken: string,
): boolean {
  return (
    hasToken(headers.upgrade, upgradeToken) &&
    hasToken(headers.connection, "upgrade")
  );
}

/** Negotiate server compression and TLS response headers. */
export function buildServerHandshakeHeaders(
  policy: LocalHandshakePolicy,
  requestHeaders: Record<string, string>,
  remoteIp?: string,
): Record<string, string> {
  const headers = buildBaseHandshakeHeaders(policy, remoteIp);
  if (
    policy.tlsEnabled &&
    peerRequestedTlsUpgrade(requestHeaders, policy.tlsUpgradeToken)
  ) {
    headers.upgrade = policy.tlsUpgradeToken;
    headers.connection = "Upgrade";
  }
  if (
    policy.enableCompression &&
    hasToken(requestHeaders["accept-encoding"], "deflate")
  ) {
    headers["content-encoding"] = "deflate";
  }
  return headers;
}

/** Confirm negotiated compression and TLS headers. */
export function buildClientFinalHeaders(
  policy: LocalHandshakePolicy,
  serverHeaders: Record<string, string>,
  remoteIp?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const observedRemote = parseRemoteIpHeader(remoteIp);
  if (observedRemote) headers["remote-ip"] = observedRemote;
  if (
    policy.tlsEnabled &&
    peerAcceptedTlsUpgrade(serverHeaders, policy.tlsUpgradeToken)
  )
    headers.connection = "Upgrade";
  if (
    policy.enableCompression &&
    hasToken(serverHeaders["accept-encoding"], "deflate")
  ) {
    headers["content-encoding"] = "deflate";
  }
  return headers;
}

/** Interpret remote handshake features and capabilities. */
export function buildPeerCapabilities(
  policy: CapabilityPolicy,
): PeerCapabilities {
  const h = lowerCaseHeaders(policy.headers);
  return {
    version: policy.version,
    headers: h,
    userAgent: h["user-agent"],
    supportsGgep: !!h.ggep,
    supportsPongCaching: !!h["pong-caching"],
    supportsBye: !!h["bye-packet"],
    supportsTls:
      policy.tlsEnabled &&
      peerRequestedTlsUpgrade(h, policy.tlsUpgradeToken),
    supportsCompression:
      hasToken(h["accept-encoding"], "deflate") ||
      hasToken(h["content-encoding"], "deflate"),
    compressIn: policy.compressIn,
    compressOut: policy.compressOut,
    isUltrapeer: parseBoolHeader(h["x-ultrapeer"]),
    ultrapeerNeeded: parseBoolHeader(h["x-ultrapeer-needed"]),
    queryRoutingVersion: h["x-query-routing"],
    ultrapeerQueryRoutingVersion: h["x-ultrapeer-query-routing"],
    dynamicQueryingVersion: h["x-dynamic-querying"],
    extProbesVersion: h["x-ext-probes"],
    degree: parsePositiveIntHeader(h["x-degree"]),
    isCrawler: !!h.crawler,
    listenIp:
      parseListenIpHeader(h["listen-ip"]) ?? parseListenIpHeader(h.node),
  };
}
