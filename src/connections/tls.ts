import net from "node:net";
import tls from "node:tls";
import { ENABLE_TLS } from "../const";
import { errMsg } from "../shared";
import type { PeerConnections } from "./connections";
import { createTlsIdentity } from "./tls_identity";

const TLS_UPGRADE_TOKEN = "TLS/1.0";
const TLS_TIMEOUT_MS = 5000;

// Opportunistic TLS encrypts traffic without authenticating remote identities.
// Generate a fresh process-local key rather than distributing a shared private key.
let secureContext: tls.SecureContext | undefined;
let tlsContextError: Error | undefined;

function hasHeaderToken(
  value: string | undefined,
  token: string,
): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .includes(token.toLowerCase());
}

function tlsContext(): tls.SecureContext {
  if (secureContext) return secureContext;
  if (tlsContextError) throw tlsContextError;
  try {
    secureContext = tls.createSecureContext({
      ...createTlsIdentity(),
      minVersion: "TLSv1.2",
    });
    return secureContext;
  } catch (error) {
    tlsContextError =
      error instanceof Error ? error : new Error(errMsg(error));
    throw tlsContextError;
  }
}

function secureEventNames(mode: "client" | "server"): string[] {
  return mode === "client"
    ? ["secureConnect", "secure"]
    : ["secure", "secureConnect"];
}

function waitForSecureTlsSocket(
  connections: PeerConnections,
  socket: tls.TLSSocket,
  mode: "client" | "server",
  timeoutMs: number,
  start?: () => void,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      connections.deps.scheduler.clearTimeout(timer);
      for (const event of secureEventNames(mode)) {
        socket.off(event, onSecure);
      }
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (value: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error instanceof Error ? error : new Error(errMsg(error)));
    };
    const onSecure = () => finish(socket);
    const onError = (error: unknown) => fail(error);
    const onClose = () => fail(new Error("TLS socket closed"));
    const timer = connections.deps.scheduler.setTimeout(() => {
      fail(new Error("TLS handshake timeout"));
    }, timeoutMs);

    for (const event of secureEventNames(mode)) {
      socket.once(event, onSecure);
    }
    socket.once("error", onError);
    socket.once("close", onClose);
    try {
      start?.();
    } catch (error) {
      fail(error);
    }
  });
}

/** Check whether TLS is configured and usable. */
export function tlsEnabled(connections: PeerConnections): boolean {
  if (!ENABLE_TLS) return false;
  if (!connections.config().enableTls) return false;
  try {
    tlsContext();
    return true;
  } catch {
    return false;
  }
}

/** Check whether a socket is encrypted. */
export function socketUsesTls(
  _connections: PeerConnections,
  socket: net.Socket,
): boolean {
  return (
    socket instanceof tls.TLSSocket ||
    !!(socket as net.Socket & { encrypted?: boolean }).encrypted
  );
}

/** Check whether the socket supports TLS wrapping. */
export function canUpgradeSocketToTls(
  _connections: PeerConnections,
  socket: net.Socket,
): boolean {
  return socket instanceof net.Socket;
}

/** Check for a requested TLS upgrade token. */
export function peerRequestedTlsUpgrade(
  _connections: PeerConnections,
  headers: Record<string, string>,
): boolean {
  return hasHeaderToken(headers["upgrade"], TLS_UPGRADE_TOKEN);
}

/** Check the server's TLS upgrade acknowledgment. */
export function peerAcceptedTlsUpgrade(
  _connections: PeerConnections,
  headers: Record<string, string>,
): boolean {
  return (
    hasHeaderToken(headers["upgrade"], TLS_UPGRADE_TOKEN) &&
    hasHeaderToken(headers["connection"], "upgrade")
  );
}

/** Check the client's final TLS upgrade acknowledgment. */
export function clientAcceptedTlsUpgrade(
  _connections: PeerConnections,
  headers: Record<string, string>,
): boolean {
  return hasHeaderToken(headers["connection"], "upgrade");
}

/** Return the advertised TLS upgrade token. */
export function tlsUpgradeToken(_connections: PeerConnections): string {
  return TLS_UPGRADE_TOKEN;
}

/** Negotiate TLS while preserving buffered handshake bytes. */
export async function upgradeSocketToTls(
  connections: PeerConnections,
  socket: net.Socket,
  mode: "client" | "server",
  initialBuf: Uint8Array = Buffer.alloc(0),
): Promise<tls.TLSSocket> {
  if (!connections.tlsEnabled()) throw new Error("TLS unavailable");
  // Pause before unshift: flowing sockets can consume replayed ClientHello bytes.
  socket.pause();
  if (initialBuf.length) socket.unshift(initialBuf);
  socket.setTimeout(0);

  const timeoutMs = Math.max(
    TLS_TIMEOUT_MS,
    connections.config().connectTimeoutMs,
  );
  const upgraded =
    mode === "client"
      ? tls.connect({
          socket,
          secureContext: tlsContext(),
          rejectUnauthorized: false,
          minVersion: "TLSv1.2",
        })
      : new tls.TLSSocket(socket, {
          isServer: true,
          secureContext: tlsContext(),
          requestCert: false,
          rejectUnauthorized: false,
        });
  connections.releaseSocket(socket);
  connections.trackSocket(upgraded);
  return await waitForSecureTlsSocket(
    connections,
    upgraded,
    mode,
    timeoutMs,
    () => {
      upgraded.setNoDelay(true);
      upgraded.resume();
    },
  );
}

/** Check whether both peers agreed to an available TLS upgrade. */
export function shouldUpgradeSocketToTls(
  connections: PeerConnections,
  socket: net.Socket,
  acceptedByServer: boolean,
  acceptedByClient: boolean,
): boolean {
  return (
    connections.tlsEnabled() &&
    connections.canUpgradeSocketToTls(socket) &&
    acceptedByServer &&
    acceptedByClient
  );
}
