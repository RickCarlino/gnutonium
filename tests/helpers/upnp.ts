import type { PortMapping } from "../../src/nat/gateway";
import { xmlValue } from "../../src/nat/soap";

function actionName(request: Request): string {
  return (request.headers.get("soapaction") || "")
    .split("#")
    .at(-1)!
    .replaceAll('"', "");
}

function mappingFromXml(body: string): PortMapping {
  return {
    client: xmlValue(body, "NewInternalClient") || "",
    port: Number(xmlValue(body, "NewInternalPort")),
    description: xmlValue(body, "NewPortMappingDescription") || "",
  };
}

/** A loopback IGD fixture exercising actual HTTP/SOAP without touching a router. */
export function fakeGateway() {
  let mapping: PortMapping | undefined;
  let publicAddress = "44.55.66.77";
  let permanentOnly = false;
  const requests: Array<{ action: string; body: string }> = [];
  const type = "urn:schemas-upnp-org:service:WANIPConnection:1";
  const response = (action: string, fields = "") =>
    new Response(
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${type}">${fields}</u:${action}Response></s:Body></s:Envelope>`,
    );
  const fault = (code: number) =>
    new Response(
      `<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`,
      { status: 500 },
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET")
        return new Response(
          `<root><device><serviceList><service><serviceType>${type}</serviceType><controlURL>/control</controlURL></service></serviceList></device></root>`,
        );
      const action = actionName(request);
      const body = await request.text();
      requests.push({ action, body });
      switch (action) {
        case "GetExternalIPAddress":
          return response(
            action,
            `<NewExternalIPAddress>${publicAddress}</NewExternalIPAddress>`,
          );
        case "GetSpecificPortMappingEntry":
          if (!mapping) return fault(714);
          return response(
            action,
            `<NewInternalClient>${mapping.client}</NewInternalClient><NewInternalPort>${mapping.port}</NewInternalPort><NewPortMappingDescription>${mapping.description}</NewPortMappingDescription>`,
          );
        case "AddPortMapping":
          if (permanentOnly && xmlValue(body, "NewLeaseDuration") !== "0")
            return fault(725);
          mapping = mappingFromXml(body);
          return response(action);
        case "DeletePortMapping":
          mapping = undefined;
          return response(action);
        default:
          return fault(401);
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/root.xml`,
    requests,
    mapping: () => mapping,
    setAddress: (host: string) => {
      publicAddress = host;
    },
    permanent: () => {
      permanentOnly = true;
    },
    close: () => server.stop(true),
  };
}
