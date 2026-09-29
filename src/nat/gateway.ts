import { isRoutableIpv4 } from "../shared";
import {
  parseServices,
  requestXml,
  soap,
  SoapError,
  xmlValue,
  type GatewayService,
} from "./soap";
import { discoverLocations } from "./ssdp";

export type PortMapping = {
  client: string;
  port: number;
  description: string;
};

export type NatGateway = {
  localAddress: string;
  externalAddress(): Promise<string>;
  lookup(port: number): Promise<PortMapping | undefined>;
  add(port: number, description: string, lease: number): Promise<void>;
  remove(port: number): Promise<void>;
};

/** Build a small IGD control client; TCP is the only mapped transport. */
export function createGateway(service: GatewayService): NatGateway {
  const key = (port: number) => ({
    NewRemoteHost: "",
    NewExternalPort: port,
    NewProtocol: "TCP",
  });
  return {
    localAddress: service.localAddress,
    async externalAddress() {
      const xml = await soap(service, "GetExternalIPAddress");
      const host = xmlValue(xml, "NewExternalIPAddress") || "";
      if (!isRoutableIpv4(host))
        throw new Error(
          "Router has no public IPv4 address (possibly double NAT)",
        );
      return host;
    },
    async lookup(port) {
      try {
        const xml = await soap(
          service,
          "GetSpecificPortMappingEntry",
          key(port),
        );
        return {
          client: xmlValue(xml, "NewInternalClient") || "",
          port: Number(xmlValue(xml, "NewInternalPort")),
          description: xmlValue(xml, "NewPortMappingDescription") || "",
        };
      } catch (error) {
        if (error instanceof SoapError && error.code === "714")
          return undefined;
        throw error;
      }
    },
    async add(port, description, lease) {
      await soap(service, "AddPortMapping", {
        ...key(port),
        NewInternalPort: port,
        NewInternalClient: service.localAddress,
        NewEnabled: 1,
        NewPortMappingDescription: description,
        NewLeaseDuration: lease,
      });
    },
    async remove(port) {
      await soap(service, "DeletePortMapping", key(port));
    },
  };
}

/** Discover and describe a bounded set of gateways without blocking startup. */
export async function discoverGateways(
  listenHost: string,
  signal: AbortSignal,
): Promise<NatGateway[]> {
  const locations = await discoverLocations(listenHost, signal);
  const results = await Promise.all(
    locations.map(async (location) => {
      try {
        const { xml, ok } = await requestXml(location.url, { signal });
        return ok ? parseServices(xml, location).map(createGateway) : [];
      } catch {
        return [];
      }
    }),
  );
  return results.flat().slice(0, 8);
}
