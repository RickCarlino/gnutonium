import { detectLocalAdvertisedIpv4 } from "../config/document";
import { isUnspecifiedIpv4, normalizeIpv4 } from "../shared";
import type { PeerAddr, RuntimeConfig } from "../types";
import { observedAdvertisedHostCandidate } from "./observed_address";

type AddressConfig = Pick<
  RuntimeConfig,
  "advertisedHost" | "advertisedPort" | "listenHost" | "listenPort"
>;

/** Tracks configured, router-mapped and peer-observed local endpoints. */
export class LocalAddress {
  mappedEndpoint?: PeerAddr;
  learnedAdvertisedHost?: string;
  private pendingAdvertisedHost?: string;
  private pendingAdvertisedSubnets = new Set<string>();

  /** Attach the current address settings provider. */
  constructor(private readonly config: () => AddressConfig) {}

  /** Return the explicitly configured advertised host. */
  configuredAdvertisedHost(): string | undefined {
    const raw = this.config().advertisedHost;
    if (typeof raw !== "string") return undefined;
    const host = raw.trim();
    return host || undefined;
  }

  /** Choose the advertised port or listening port. */
  currentAdvertisedPort(): number {
    const configured = this.config().advertisedPort;
    return Number.isInteger(configured) && (configured || 0) > 0
      ? (configured as number)
      : this.mappedEndpoint?.port || this.config().listenPort;
  }

  /** Choose the configured, mapped, learned, or local host. */
  currentAdvertisedHost(): string {
    return (
      this.configuredAdvertisedHost() ||
      this.mappedEndpoint?.host ||
      this.learnedAdvertisedHost ||
      detectLocalAdvertisedIpv4(this.config().listenHost)
    );
  }

  /** Collect normalized addresses that identify this node. */
  selfHosts(): Set<string> {
    const out = new Set<string>();
    const push = (host: string | undefined) => {
      const normalized = normalizeIpv4(host);
      if (normalized && !isUnspecifiedIpv4(normalized))
        out.add(normalized);
    };
    push(this.configuredAdvertisedHost());
    push(this.learnedAdvertisedHost);
    push(this.mappedEndpoint?.host);
    push(this.config().listenHost);
    push(detectLocalAdvertisedIpv4(this.config().listenHost));
    return out;
  }

  /** Check whether an endpoint refers to this node. */
  isSelfPeer(host: string, port: number): boolean {
    const normalizedHost = normalizeIpv4(host);
    if (!normalizedHost || !port) return false;
    const ports = new Set([
      this.config().listenPort,
      this.currentAdvertisedPort(),
    ]);
    return ports.has(port) && this.selfHosts().has(normalizedHost);
  }

  /** Consider a peer's report when no host is configured. */
  maybeObserveAdvertisedHost(
    headers: Record<string, string>,
    reporterHost?: string,
  ): void {
    if (this.configuredAdvertisedHost()) return;
    const observed = observedAdvertisedHostCandidate(
      headers,
      reporterHost,
    );
    if (!observed) return;
    const { observedHost, subnet } = observed;
    if (observedHost === this.learnedAdvertisedHost) return;
    this.trackPendingAdvertisedHost(observedHost, subnet);
  }

  /** Adopt an address after three independent subnet reports. */
  trackPendingAdvertisedHost(observedHost: string, subnet: string): void {
    if (this.pendingAdvertisedHost !== observedHost) {
      this.pendingAdvertisedHost = observedHost;
      this.pendingAdvertisedSubnets.clear();
    }
    this.pendingAdvertisedSubnets.add(subnet);
    if (this.pendingAdvertisedSubnets.size < 3) return;

    this.learnedAdvertisedHost = observedHost;
    this.pendingAdvertisedHost = undefined;
    this.pendingAdvertisedSubnets.clear();
  }
}
