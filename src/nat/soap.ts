import { gatewayUrl, type GatewayLocation } from "./ssdp";

export type GatewayService = GatewayLocation & {
  serviceType: string;
  controlUrl: string;
};

function decodeXml(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, entity: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!,
  );
}

function escapeXml(value: string | number): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );
}

/** Read the simple scalar elements used by IGD descriptions and SOAP. */
export function xmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(
    new RegExp(
      `<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?${tag}\\s*>`,
    ),
  );
  return match ? decodeXml(match[1].trim()) : undefined;
}

/** Find WAN IP/PPP services, including namespaced IGD v1/v2 descriptions. */
export function parseServices(
  xml: string,
  location: GatewayLocation,
): GatewayService[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Unsupported UPnP XML declaration");
  const host = new URL(location.url).hostname;
  const base = gatewayUrl(xmlValue(xml, "URLBase") || location.url, host);
  const services: GatewayService[] = [];
  const blocks = xml.matchAll(
    /<(?:[\w.-]+:)?service\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?service\s*>/g,
  );
  for (const block of blocks) {
    const serviceType = xmlValue(block[1], "serviceType") || "";
    const control = xmlValue(block[1], "controlURL");
    if (
      !/^urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:[12]$/.test(
        serviceType,
      ) ||
      !control
    )
      continue;
    services.push({
      ...location,
      serviceType,
      controlUrl: gatewayUrl(control, host, base),
    });
  }
  return services;
}

/** Fetch bounded router XML, with no redirects and a deadline covering its body. */
export async function requestXml(
  url: string,
  init: RequestInit = {},
): Promise<{ xml: string; ok: boolean }> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(2000)])
    : AbortSignal.timeout(2000);
  const response = await fetch(url, {
    ...init,
    signal,
    redirect: "error",
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty UPnP response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) throw new Error("UPnP response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return { xml: Buffer.concat(chunks).toString("utf8"), ok: response.ok };
}

export class SoapError extends Error {
  constructor(readonly code: string) {
    super(`UPnP error ${code}`);
  }
}

/** Invoke one action on a discovered WAN connection service. */
export async function soap(
  service: GatewayService,
  action: string,
  args: Record<string, string | number> = {},
): Promise<string> {
  const fields = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join("");
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.serviceType}">${fields}</u:${action}></s:Body></s:Envelope>`;
  const { xml, ok } = await requestXml(service.controlUrl, {
    method: "POST",
    body,
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPAction: `"${service.serviceType}#${action}"`,
    },
  });
  const code = xmlValue(xml, "errorCode");
  if (code) throw new SoapError(code);
  if (
    !ok ||
    !new RegExp(`<(?:[\\w.-]+:)?${action}Response(?:[\\s/>])`).test(xml)
  )
    throw new Error(`Invalid UPnP ${action} response`);
  return xml;
}
