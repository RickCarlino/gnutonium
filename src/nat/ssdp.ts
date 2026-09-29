import dgram from "node:dgram";
import { isIPv4 } from "node:net";
import os from "node:os";

export type GatewayLocation = {
  url: string;
  localAddress: string;
};

/** Limit automatic gateway discovery to private IPv4 interfaces. */
export function isPrivateAddress(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split(".").map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Keep description and control requests on the responding device. */
export function gatewayUrl(
  value: string,
  host: string,
  base?: string,
): string {
  const url = new URL(value, base);
  if (
    url.protocol !== "http:" ||
    url.hostname !== host ||
    url.username ||
    url.password
  )
    throw new Error("Invalid UPnP gateway URL");
  return url.href;
}

/** Parse a bounded SSDP response without following remote locations. */
export function responseLocation(
  message: Buffer,
  host: string,
): string | undefined {
  if (message.length > 8192 || !isPrivateAddress(host)) return;
  const lines = message.toString().split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200\b/.test(lines[0])) return;
  const location = lines.find((line) => /^location:/i.test(line));
  if (!location) return;
  try {
    return gatewayUrl(
      location.slice(location.indexOf(":") + 1).trim(),
      host,
    );
  } catch {
    return;
  }
}

function searchInterface(
  localAddress: string,
  signal: AbortSignal,
): Promise<GatewayLocation[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const locations = new Set<string>();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      try {
        socket.close();
      } catch {
        /* Socket may not have bound. */
      }
      resolve([...locations].map((url) => ({ url, localAddress })));
    };
    const timer = setTimeout(finish, 2500);
    signal.addEventListener("abort", finish, { once: true });
    socket.on("error", finish);
    socket.on("message", (message, remote) => {
      const url = responseLocation(message, remote.address);
      if (url && locations.size < 8) locations.add(url);
    });
    if (signal.aborted) return finish();
    socket.bind(0, localAddress, () => {
      if (finished) return;
      try {
        socket.setMulticastInterface(localAddress);
        socket.setMulticastTTL(2);
        const request = Buffer.from(
          [
            "M-SEARCH * HTTP/1.1",
            "HOST: 239.255.255.250:1900",
            'MAN: "ssdp:discover"',
            "MX: 2",
            "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1",
            "",
            "",
          ].join("\r\n"),
        );
        // UDP delivery is best effort; repeat the small discovery request.
        for (let i = 0; i < 2; i++)
          socket.send(request, 1900, "239.255.255.250", (error) => {
            if (error) finish();
          });
      } catch {
        finish();
      }
    });
  });
}

/** Search interfaces on which the application's IPv4 listener is reachable. */
export async function discoverLocations(
  listenHost: string,
  signal: AbortSignal,
): Promise<GatewayLocation[]> {
  if (listenHost !== "0.0.0.0" && !isPrivateAddress(listenHost)) return [];
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => !entry.internal && isPrivateAddress(entry.address))
    .map((entry) => entry.address)
    .filter(
      (address) => listenHost === "0.0.0.0" || listenHost === address,
    );
  const results = await Promise.all(
    [...new Set(addresses)]
      .slice(0, 8)
      .map((address) => searchInterface(address, signal)),
  );
  return results.flat().slice(0, 8);
}
