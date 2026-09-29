import { randomUUID } from "node:crypto";
import { errMsg } from "../shared";
import type {
  GnutellaServentCollaborators,
  PeerAddr,
  RuntimeConfig,
} from "../types";
import type { NatGateway, PortMapping } from "./gateway";
import { SoapError } from "./soap";
import { isPrivateAddress } from "./ssdp";

export type NatStatus = {
  state: "mapped" | "unavailable" | "skipped";
  message: string;
};

type NatConfig = Pick<
  RuntimeConfig,
  "listenHost" | "listenPort" | "advertisedHost" | "advertisedPort"
>;
type NatDependencies = {
  discover: typeof import("./gateway").discoverGateways;
  scheduler: Pick<
    GnutellaServentCollaborators["scheduler"],
    "setTimeout" | "clearTimeout"
  >;
  address: (endpoint: PeerAddr | undefined) => void;
  report: (status: NatStatus) => void;
};
type ActiveMapping = { gateway: NatGateway; port: number; lease: number };

/** Owns best-effort discovery, mapping renewal and only this process's cleanup. */
export class NatService {
  private readonly description = `Gnutonium ${randomUUID()}`;
  private readonly controller = new AbortController();
  private active?: ActiveMapping;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private stopped = false;
  private lastReport?: string;

  constructor(private readonly deps: NatDependencies) {}

  /** Launch automatically; callers need not await discovery before connecting. */
  start(config: NatConfig): Promise<void> {
    if (this.pending || this.stopped)
      return this.pending || Promise.resolve();
    if (config.advertisedHost || config.advertisedPort) {
      this.report(
        "skipped",
        "Using manually configured advertised endpoint",
      );
      return Promise.resolve();
    }
    if (
      config.listenHost !== "0.0.0.0" &&
      !isPrivateAddress(config.listenHost)
    ) {
      this.report(
        "skipped",
        "Listener is not on a private IPv4 interface",
      );
      return Promise.resolve();
    }
    return this.launch(config);
  }

  private launch(config: NatConfig): Promise<void> {
    this.pending = this.run(config).finally(() => {
      if (this.stopped) return;
      // Renew a one-hour lease at twenty minutes; retry failures after a minute.
      this.timer = this.deps.scheduler.setTimeout(
        () => {
          void this.launch(config);
        },
        this.lastReport?.startsWith("mapped:") ? 20 * 60_000 : 60_000,
      );
    });
    return this.pending;
  }

  private async run(config: NatConfig): Promise<void> {
    try {
      if (this.active) {
        await this.renew(this.active);
        return;
      }
      await this.discover(config);
    } catch (error) {
      this.deps.address(undefined);
      this.report("unavailable", errMsg(error));
    }
  }

  private async discover(config: NatConfig): Promise<void> {
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(10_000),
    ]);
    const gateways = await this.deps.discover(config.listenHost, signal);
    let failure =
      "No UPnP gateway found; continuing without automatic port forwarding";
    for (const gateway of gateways) {
      if (this.stopped) return;
      try {
        const host = await gateway.externalAddress();
        const mapping = { gateway, port: config.listenPort, lease: 3600 };
        await this.ensureMapping(mapping);
        this.active = mapping;
        this.publish(host, mapping.port);
        return;
      } catch (error) {
        failure = errMsg(error);
      }
    }
    if (!this.stopped) throw new Error(failure);
  }

  private owns(
    entry: PortMapping | undefined,
    mapping: ActiveMapping,
  ): boolean {
    return (
      entry?.client === mapping.gateway.localAddress &&
      entry.port === mapping.port &&
      entry.description === this.description
    );
  }

  private async ensureMapping(mapping: ActiveMapping): Promise<void> {
    const { gateway, port } = mapping;
    const existing = await gateway.lookup(port);
    if (existing && !this.owns(existing, mapping))
      throw new Error(`TCP port ${port} already has a router mapping`);
    if (this.stopped) throw new Error("UPnP stopped");
    try {
      await gateway.add(port, this.description, mapping.lease);
    } catch (error) {
      if (!(error instanceof SoapError) || error.code !== "725")
        throw error;
      if (this.stopped) throw new Error("UPnP stopped");
      mapping.lease = 0; // Older IGD v1 routers only allow permanent leases.
      await gateway.add(port, this.description, 0);
    }
  }

  private async renew(mapping: ActiveMapping): Promise<void> {
    try {
      await this.ensureMapping(mapping);
    } catch (error) {
      // A reboot or changed mapping requires fresh discovery on the next retry.
      // Keep ownership information until cleanup has been attempted.
      await this.removeOwned(mapping);
      this.active = undefined;
      throw error;
    }
    const host = await mapping.gateway.externalAddress();
    this.publish(host, mapping.port);
  }

  private publish(host: string, port: number): void {
    if (this.stopped) return;
    this.deps.address({ host, port });
    this.report(
      "mapped",
      `TCP ${host}:${port} mapped (inbound reachability not yet verified)`,
    );
  }

  private report(state: NatStatus["state"], message: string): void {
    if (this.stopped) return;
    const key = `${state}:${message}`;
    if (key === this.lastReport) return;
    this.lastReport = key;
    this.deps.report({ state, message });
  }

  private async removeOwned(mapping: ActiveMapping): Promise<void> {
    try {
      if (this.owns(await mapping.gateway.lookup(mapping.port), mapping))
        await mapping.gateway.remove(mapping.port);
    } catch {
      /* Router may be offline; finite leases expire on their own. */
    }
  }

  /** Cancel discovery, await an in-flight add, and remove only our own mapping. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    if (this.timer) this.deps.scheduler.clearTimeout(this.timer);
    await this.pending;
    if (this.active) await this.removeOwned(this.active);
    this.active = undefined;
    this.deps.address(undefined);
  }
}
