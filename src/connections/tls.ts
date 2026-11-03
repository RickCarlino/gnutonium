import net from "node:net";
import tls from "node:tls";
import { ENABLE_TLS } from "../const";
import { errMsg } from "../shared";
import type { PeerConnections } from "./connections";

const TLS_UPGRADE_TOKEN = "TLS/1.0";
const TLS_TIMEOUT_MS = 5000;

// Opportunistic peer TLS does not authenticate remote identity, so a
// bundled self-signed certificate is sufficient for server-side handshakes.
const TLS_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQD4hBqeBHY43TlX
zVeqDytDe9/8aJGk4DL9RXWdU6fExvMySt5l30OVBH/WqrAtSsxTzYF6Ara8erXG
vPQq0HbtbnAGzB7VOcadYCYFJFiNFQoR50U4vq0MHE/4QEHsRGZFtB1HRIrHEqJp
m9TYbaL6/Nw4atzcvEWcjok5rpvy2NHyI1QueixOb7KeukSrgR6WUNCldi0YPuXP
kePe48nifnzlbw2MqYP5u+TdThpyu5KGLwsvHOUUhr7HrEGpcl8FHpAhsWE2HzVE
5LGLLK3goASjJOYokl56yzLPNC4PgsmdgpykiMHqDXEwAfaM7dRb2BhAzx4jpxbv
jwbbJJtPAgMBAAECggEAAOBWD8JTM4UKhR9L71Ei/o2MT3ZhSxKjbYw/0qjG/K0I
3+hInEmnkMB3aqS1m7Xib0XpgSSKgmJjD/EIcG/lOCL3zIIzz38FK5fIbqxbAfDM
kwyzHBXt7apTBC4rFZxwhCzvMpjLU+u884mQL1K3d8vPjhCFJNJ/8WVa+0ulJyp+
otlQVzKWH5T/jjUlTxnaImsIdI8grqaBSC5Fd5Dnay0qUNYx3t5UFlkAZzWc/Uua
EuDvid1fsFGHbkXrh9jFLLKd+7MnNjCeQf56xzbN8mvFntnnqCJm3AywMGEQwwHB
84e/2jEeJBQsLuft1qAk2Wr3gKBkF8vcooDoArFpKQKBgQD/GIGsJGcfT5JnMobP
6Dv7UEIasv5MUZ6PSvB4bLk/AItnAms27No28w32S5X5f19Wm8+ff7AWdEjbs/XP
rgnLV6QL0e8pQCNBT5kfXidydrZrH8rbSV0h3Ius+UQSEMNnjBaJ8mgPUsH//jBh
dM077jSgoP3KHjQk2UHp9+p0yQKBgQD5ZaBjdQemDeI6D8Jzowjrr4IT0Y9wrT0u
O8noRMDxJM1BfFxOB/yrM+mMVEapOFuR7qTcHuJFUUSktROlhwvDHFSXEPs9/0Vy
d8FFgbd0OF4+Hdg5yk0F7LjgXh982Dc2H363vlPiOZ8BklTX73bnlw9WvgBDxqri
H7JW92wTVwKBgQD0W0tL1IsbySNay2GsIq/iat0HqlJCVSTn6kczdCJ3IVRn1j9R
m8zkOisztO/y0XpIAnT+Olg5CicInfhnejVTnZ483FqWTyP2WgM5sv1ifij7sLan
HD2kRBlgFl6IV5p2xBCLD7NyijnfuGQr1rEKKYIsJEs3o3sbmSm0r5DdUQKBgQCm
F5ZvZjtHzatCO8imtod0XxhkFoZO5jD+n3biJxfQAVBpMmdO2Gbfpdz+RgohHJVv
ZN2Kc08CFxN+FdIVxRCCSlXTnc2VBnK7vyGKJs+EqR2qhLnCEwak0Xh2hHi37k8m
zmbX+/tliDZrF4dFoAcySRpADJ2khaS8n5tn67OgVQKBgQDyHZ4zruZo5b+GQC+5
IN/FrtviKu0+W2dA+PGwxMcUF+373IDq7Kp+8A8j+QtG0uPYMZiFrWb10Aqp5yjZ
PH6GWdABuZ61cWEdbFCgG6/NCOWB84iPSHkttZPi0r+EbspHeIlLixUIFSVKUeLf
jlzk/A25vxdNIA4F+dVdBBy/Pg==
-----END PRIVATE KEY-----
`;

const TLS_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIURECewiM0o9kR9MKlXP0py8dw0XYwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMZ251dGVsbGEtYnVuMB4XDTI2MDMyODA2NDMwMVoXDTM2
MDMyNTA2NDMwMVowFzEVMBMGA1UEAwwMZ251dGVsbGEtYnVuMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEA+IQangR2ON05V81Xqg8rQ3vf/GiRpOAy/UV1
nVOnxMbzMkreZd9DlQR/1qqwLUrMU82BegK2vHq1xrz0KtB27W5wBswe1TnGnWAm
BSRYjRUKEedFOL6tDBxP+EBB7ERmRbQdR0SKxxKiaZvU2G2i+vzcOGrc3LxFnI6J
Oa6b8tjR8iNULnosTm+ynrpEq4EellDQpXYtGD7lz5Hj3uPJ4n585W8NjKmD+bvk
3U4acruShi8LLxzlFIa+x6xBqXJfBR6QIbFhNh81ROSxiyyt4KAEoyTmKJJeessy
zzQuD4LJnYKcpIjB6g1xMAH2jO3UW9gYQM8eI6cW748G2ySbTwIDAQABo1MwUTAd
BgNVHQ4EFgQUmmjFyMO+Yec6uc5oDZ32eQZpTVcwHwYDVR0jBBgwFoAUmmjFyMO+
Yec6uc5oDZ32eQZpTVcwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEA1GGX8oZEKsOrC5vo2wtkEuA6A4jnc6+l6E2wHNRhBpK7Pi77i/IijMoAvW/d
6C+6vLNogZEsavsi9zfwxjCmu6eJO4QW7/Jpoev8ZPQQE0cDZUQigF5B6Qy8HQ1L
PT836ReE3X2e7TPVwrhtDC8hNSRar+Wh0VZXHvwhEkyfuea75QgYE8jyqpAviYZT
jH7OHoVlXZyuRBQOh03PJt+ZZyJLG172C39dmeNXC/N5a07PvDH0TRVlvdbnQVfE
J7/6IhSn3XbO000zgwcdGjZbPVym/xNiidJCPxrqF7ZaGWfWLmNXLnuGrOm0FusM
x+z+mIKYbuX4pACxG4t1ycRfOQ==
-----END CERTIFICATE-----
`;

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
      key: TLS_KEY_PEM,
      cert: TLS_CERT_PEM,
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
