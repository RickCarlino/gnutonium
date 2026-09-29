import { expect, test } from "bun:test";
import { LocalAddress } from "../../../src/discovery/local_address";
import { parseServices } from "../../../src/nat/soap";
import {
  discoverLocations,
  responseLocation,
} from "../../../src/nat/ssdp";

test("SSDP accepts case-insensitive location headers only on the responding private host", () => {
  const response = (url: string) =>
    Buffer.from(`HTTP/1.1 200 OK\r\nlOcAtIoN: ${url}\r\n\r\n`);
  expect(
    responseLocation(
      response("http://192.168.1.1:1234/root.xml"),
      "192.168.1.1",
    ),
  ).toBe("http://192.168.1.1:1234/root.xml");
  for (const url of [
    "http://127.0.0.1/",
    "http://example.com/",
    "file:///tmp/secret",
    "http://user:pass@192.168.1.1/",
  ])
    expect(responseLocation(response(url), "192.168.1.1")).toBeUndefined();
  expect(
    responseLocation(response("http://8.8.8.8/"), "8.8.8.8"),
  ).toBeUndefined();
  expect(
    responseLocation(Buffer.alloc(9000), "192.168.1.1"),
  ).toBeUndefined();
});

test("IGD descriptions handle namespaces, URLBase, XML escapes and PPP services", () => {
  const location = {
    url: "http://192.168.1.1:1234/root.xml",
    localAddress: "192.168.1.2",
  };
  const xml = `<root><URLBase>http://192.168.1.1:4321/base/</URLBase><serviceList>
    <d:service><d:serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</d:serviceType><d:controlURL>ip?a=1&amp;b=2</d:controlURL></d:service>
    <service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>/ppp</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/ignored</controlURL></service>
    </serviceList></root>`;
  const services = parseServices(xml, location);
  expect(services).toHaveLength(2);
  expect(services[0].controlUrl).toBe(
    "http://192.168.1.1:4321/base/ip?a=1&b=2",
  );
  expect(services[1].controlUrl).toBe("http://192.168.1.1:4321/ppp");
  expect(() =>
    parseServices(xml.replace("/ppp", "http://127.0.0.1/"), location),
  ).toThrow();
  expect(() => parseServices(`<!DOCTYPE root>${xml}`, location)).toThrow();
});

test("loopback discovery does not send SSDP", async () => {
  expect(
    await discoverLocations("127.0.0.1", new AbortController().signal),
  ).toEqual([]);
});

test("mapped endpoints feed advertisement and self detection without overwriting manual settings", () => {
  const config = {
    listenHost: "127.0.0.1",
    listenPort: 6346,
    advertisedHost: "",
    advertisedPort: 0,
  };
  const address = new LocalAddress(() => config);
  address.learnedAdvertisedHost = "44.55.66.88";
  address.mappedEndpoint = { host: "44.55.66.77", port: 6346 };
  expect(address.currentAdvertisedHost()).toBe("44.55.66.77");
  expect(address.isSelfPeer("44.55.66.77", 6346)).toBe(true);
  config.advertisedHost = "55.66.77.88";
  config.advertisedPort = 7000;
  expect(address.currentAdvertisedHost()).toBe("55.66.77.88");
  expect(address.currentAdvertisedPort()).toBe(7000);
  config.advertisedHost = "";
  address.mappedEndpoint = undefined;
  expect(address.currentAdvertisedHost()).toBe("44.55.66.88");
});
