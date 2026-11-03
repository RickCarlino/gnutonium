import { expect, spyOn, test } from "bun:test";
import os from "node:os";
import { detectLocalAdvertisedIpv4 } from "../../../src/config/document";
import { LocalAddress } from "../../../src/discovery/local_address";

test("denied interface enumeration falls back to loopback and preserves configured addresses", () => {
  const interfaces = spyOn(os, "networkInterfaces").mockImplementation(
    () => {
      throw Object.assign(new Error("getifaddrs returned an error"), {
        errno: 1,
      });
    },
  );
  try {
    expect(detectLocalAdvertisedIpv4("192.168.1.2")).toBe("192.168.1.2");
    expect(interfaces).not.toHaveBeenCalled();
    expect(detectLocalAdvertisedIpv4("0.0.0.0")).toBe("127.0.0.1");
    const address = new LocalAddress(() => ({
      listenHost: "0.0.0.0",
      listenPort: 6346,
    }));
    expect(address.currentAdvertisedHost()).toBe("127.0.0.1");
    expect(address.isSelfPeer("127.0.0.1", 6346)).toBe(true);
    address.mappedEndpoint = { host: "8.8.8.8", port: 6346 };
    expect(address.currentAdvertisedHost()).toBe("8.8.8.8");
  } finally {
    interfaces.mockRestore();
  }
});
