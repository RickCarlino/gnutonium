import type net from "node:net";
import type { LocalAddress } from "../discovery/local_address";
import type { PeerDiscovery } from "../discovery/runtime";
import { SocketRegistry } from "../transport/socket_registry";
import type {
  GnutellaEvent,
  GnutellaServentCollaborators,
  OwnerArguments,
  RuntimeConfig,
} from "../types";
import type { DescriptorHeader } from "../wire/types";
import * as handshake from "./handshake";
import * as lifecycle from "./lifecycle";
import * as state from "./peers";
import * as topology from "./roles";
import type { PeerSession } from "./session";
import * as tlsSupport from "./tls";
import * as transport from "./transport";
import type { PeerConnection as Peer } from "./types";

type ConnectionDependencies = {
  config: () => RuntimeConfig;
  updateConfig: (patch: Partial<RuntimeConfig>) => RuntimeConfig;
  now: () => number;
  emit: (event: GnutellaEvent) => void;
  network: GnutellaServentCollaborators["netFactory"];
  scheduler: GnutellaServentCollaborators["scheduler"];
  address: Pick<
    LocalAddress,
    | "isSelfPeer"
    | "currentAdvertisedHost"
    | "currentAdvertisedPort"
    | "maybeObserveAdvertisedHost"
  >;
  discovery: Pick<
    PeerDiscovery,
    | "addKnownPeer"
    | "getKnownPeers"
    | "pruneBlockedKnownPeers"
    | "markPeerSeenIfStable"
    | "refreshGWebCacheReport"
    | "rememberPeerAddresses"
  >;
  ingress: {
    http: (socket: net.Socket, head: string, remaining: Buffer) => void;
    giv: (socket: net.Socket, head: string) => Promise<void>;
  };
  routing: {
    descriptor: (
      peer: Peer,
      header: DescriptorHeader,
      payload: Buffer,
    ) => void;
    ping: (peer: Peer, ttl: number) => void;
    publishQrp: (peer: Peer) => Promise<void>;
    dropped: (peer: Peer) => void;
    bye: (peer: Peer, code: number, reason: string) => void;
  };
};

/** Owns peer dialing, handshakes, sessions, and transport. */
export class PeerConnections {
  readonly peers = new Map<string, Peer>();
  readonly sessions = new Map<string, PeerSession>();
  private readonly sockets = new SocketRegistry();
  readonly dialing = new Set<string>();
  server: net.Server | null = null;
  peerSeq = 0;
  stopped = false;

  /** Attach connection policy and network dependencies. */
  constructor(readonly deps: ConnectionDependencies) {}

  /** Listen for incoming protocol and transfer connections. */
  startServer(
    ...args: OwnerArguments<Parameters<typeof lifecycle.startServer>>
  ): ReturnType<typeof lifecycle.startServer> {
    return lifecycle.startServer(this, ...args);
  }

  /** Shut down the listener and all peer connections. */
  async stop(): Promise<void> {
    this.stopped = true;
    await lifecycle.closeConnections(this);
  }

  /** Validate an endpoint and report its connection outcome. */
  connectToPeer(
    ...args: OwnerArguments<Parameters<typeof state.connectToPeer>>
  ): ReturnType<typeof state.connectToPeer> {
    return state.connectToPeer(this, ...args);
  }

  /** Dial an unblocked peer unless already connected or dialing. */
  connectPeer(
    ...args: OwnerArguments<Parameters<typeof lifecycle.connectPeer>>
  ): ReturnType<typeof lifecycle.connectPeer> {
    return lifecycle.connectPeer(this, ...args);
  }

  /** Return summaries of connected peers. */
  getPeers(
    ...args: OwnerArguments<Parameters<typeof state.getPeers>>
  ): ReturnType<typeof state.getPeers> {
    return state.getPeers(this, ...args);
  }

  /** Return the configured blocked IPv4 addresses. */
  getBlockedIps(
    ...args: OwnerArguments<Parameters<typeof state.getBlockedIps>>
  ): ReturnType<typeof state.getBlockedIps> {
    return state.getBlockedIps(this, ...args);
  }

  /** Block an IPv4 host and drop its connections. */
  blockIp(
    ...args: OwnerArguments<Parameters<typeof state.blockIp>>
  ): ReturnType<typeof state.blockIp> {
    return state.blockIp(this, ...args);
  }

  /** Remove an IPv4 host from the block list. */
  unblockIp(
    ...args: OwnerArguments<Parameters<typeof state.unblockIp>>
  ): ReturnType<typeof state.unblockIp> {
    return state.unblockIp(this, ...args);
  }

  /** Read the current runtime configuration. */
  config(): RuntimeConfig {
    return this.deps.config();
  }

  /** Read the injected clock in milliseconds. */
  now(): number {
    return this.deps.now();
  }

  /** Wait for the requested number of milliseconds. */
  sleep(ms: number): Promise<void> {
    return this.deps.scheduler.sleep(ms);
  }

  /** Create and track an outbound socket. */
  createConnection(options: net.NetConnectOpts): net.Socket {
    if (this.stopped) throw new Error("connections stopped");
    return this.trackSocket(this.deps.network.createConnection(options));
  }

  /** Create a server through the injected network factory. */
  createServer(listener: (socket: net.Socket) => void): net.Server {
    return this.deps.network.createServer((socket) => {
      if (this.stopped) socket.destroy();
      else listener(this.trackSocket(socket));
    });
  }

  /** Register a socket for owner shutdown. */
  trackSocket(socket: net.Socket): net.Socket {
    return this.sockets.add(socket);
  }

  /** Release socket ownership without closing it. */
  releaseSocket(socket: net.Socket): void {
    this.sockets.release(socket);
  }

  /** Destroy all sockets owned by the connection service. */
  closeSockets(): void {
    for (const session of this.sessions.values())
      session.close("shutdown");
    this.sessions.clear();
    this.sockets.close();
  }

  /** Build local identity and feature headers. */
  baseHandshakeHeaders(
    ...args: OwnerArguments<
      Parameters<typeof handshake.baseHandshakeHeaders>
    >
  ): ReturnType<typeof handshake.baseHandshakeHeaders> {
    return handshake.baseHandshakeHeaders(this, ...args);
  }

  /** Negotiate server compression and TLS response headers. */
  buildServerHandshakeHeaders(
    ...args: OwnerArguments<
      Parameters<typeof handshake.buildServerHandshakeHeaders>
    >
  ): ReturnType<typeof handshake.buildServerHandshakeHeaders> {
    return handshake.buildServerHandshakeHeaders(this, ...args);
  }

  /** Confirm negotiated compression and TLS headers. */
  buildClientFinalHeaders(
    ...args: OwnerArguments<
      Parameters<typeof handshake.buildClientFinalHeaders>
    >
  ): ReturnType<typeof handshake.buildClientFinalHeaders> {
    return handshake.buildClientFinalHeaders(this, ...args);
  }

  /** Interpret negotiated remote features and compression. */
  buildCapabilities(
    ...args: OwnerArguments<Parameters<typeof handshake.buildCapabilities>>
  ): ReturnType<typeof handshake.buildCapabilities> {
    return handshake.buildCapabilities(this, ...args);
  }

  /** Select alternate endpoints to advertise in handshakes. */
  selectTryPeers(
    ...args: OwnerArguments<Parameters<typeof handshake.selectTryPeers>>
  ): ReturnType<typeof handshake.selectTryPeers> {
    return handshake.selectTryPeers(this, ...args);
  }

  /** Remember alternate peers advertised in headers. */
  maybeAbsorbTryHeaders(
    ...args: OwnerArguments<
      Parameters<typeof handshake.maybeAbsorbTryHeaders>
    >
  ): ReturnType<typeof handshake.maybeAbsorbTryHeaders> {
    return handshake.maybeAbsorbTryHeaders(this, ...args);
  }

  /** Send a 0.6 rejection and close the socket. */
  reject06(
    ...args: OwnerArguments<Parameters<typeof handshake.reject06>>
  ): ReturnType<typeof handshake.reject06> {
    return handshake.reject06(this, ...args);
  }

  /** Classify and negotiate an incoming socket. */
  handleProbe(
    ...args: OwnerArguments<Parameters<typeof handshake.handleProbe>>
  ): ReturnType<typeof handshake.handleProbe> {
    return handshake.handleProbe(this, ...args);
  }

  /** Distinguish TLS, Gnutella, HTTP, and GIV traffic. */
  handleUndecidedProbe(
    ...args: OwnerArguments<
      Parameters<typeof handshake.handleUndecidedProbe>
    >
  ): ReturnType<typeof handshake.handleUndecidedProbe> {
    return handshake.handleUndecidedProbe(this, ...args);
  }

  /** Validate an inbound 0.6 request and send a response. */
  handleInbound06Probe(
    ...args: OwnerArguments<
      Parameters<typeof handshake.handleInbound06Probe>
    >
  ): ReturnType<typeof handshake.handleInbound06Probe> {
    return handshake.handleInbound06Probe(this, ...args);
  }

  /** Reject a complete unsupported Gnutella handshake. */
  rejectLegacyInboundProbe(
    ...args: OwnerArguments<
      Parameters<typeof handshake.rejectLegacyInboundProbe>
    >
  ): ReturnType<typeof handshake.rejectLegacyInboundProbe> {
    return handshake.rejectLegacyInboundProbe(this, ...args);
  }

  /** Hand a complete HTTP request to the transfer service. */
  startHttpProbeSession(
    ...args: OwnerArguments<
      Parameters<typeof handshake.startHttpProbeSession>
    >
  ): ReturnType<typeof handshake.startHttpProbeSession> {
    return handshake.startHttpProbeSession(this, ...args);
  }

  /** Hand a complete push callback to the transfer service. */
  startGivProbeSession(
    ...args: OwnerArguments<
      Parameters<typeof handshake.startGivProbeSession>
    >
  ): ReturnType<typeof handshake.startGivProbeSession> {
    return handshake.startGivProbeSession(this, ...args);
  }

  /** Complete inbound negotiation and attach the peer. */
  finishInbound06Probe(
    ...args: OwnerArguments<
      Parameters<typeof handshake.finishInbound06Probe>
    >
  ): ReturnType<typeof handshake.finishInbound06Probe> {
    return handshake.finishInbound06Probe(this, ...args);
  }

  /** Advance an inbound probe using buffered bytes. */
  tryDecideProbe(
    ...args: OwnerArguments<Parameters<typeof handshake.tryDecideProbe>>
  ): ReturnType<typeof handshake.tryDecideProbe> {
    return handshake.tryDecideProbe(this, ...args);
  }

  /** Dial an endpoint and complete the 0.6 handshake. */
  connectPeer06(
    ...args: OwnerArguments<Parameters<typeof handshake.connectPeer06>>
  ): ReturnType<typeof handshake.connectPeer06> {
    return handshake.connectPeer06(this, ...args);
  }

  /** Return the configured leaf or ultrapeer mode. */
  nodeMode(
    ...args: OwnerArguments<Parameters<typeof topology.nodeMode>>
  ): ReturnType<typeof topology.nodeMode> {
    return topology.nodeMode(this, ...args);
  }

  /** Determine a peer's role from negotiated capabilities. */
  classifyPeerRole(
    ...args: OwnerArguments<Parameters<typeof topology.classifyPeerRole>>
  ): ReturnType<typeof topology.classifyPeerRole> {
    return topology.classifyPeerRole(this, ...args);
  }

  /** Return a peer's assigned role. */
  peerRole(
    ...args: OwnerArguments<Parameters<typeof topology.peerRole>>
  ): ReturnType<typeof topology.peerRole> {
    return topology.peerRole(this, ...args);
  }

  /** Count peers assigned to a particular role. */
  countPeersByRole(
    ...args: OwnerArguments<Parameters<typeof topology.countPeersByRole>>
  ): ReturnType<typeof topology.countPeersByRole> {
    return topology.countPeersByRole(this, ...args);
  }

  /** Count connected leaf peers. */
  connectedLeafCount(
    ...args: OwnerArguments<Parameters<typeof topology.connectedLeafCount>>
  ): ReturnType<typeof topology.connectedLeafCount> {
    return topology.connectedLeafCount(this, ...args);
  }

  /** Count connected routing-mesh peers. */
  connectedMeshPeerCount(
    ...args: OwnerArguments<
      Parameters<typeof topology.connectedMeshPeerCount>
    >
  ): ReturnType<typeof topology.connectedMeshPeerCount> {
    return topology.connectedMeshPeerCount(this, ...args);
  }

  /** Count remaining slots after connections and pending dials. */
  availableDialSlots(
    ...args: OwnerArguments<Parameters<typeof topology.availableDialSlots>>
  ): ReturnType<typeof topology.availableDialSlots> {
    return topology.availableDialSlots(this, ...args);
  }

  /** Check connection capacity for the proposed peer role. */
  canAcceptPeerRole(
    ...args: OwnerArguments<Parameters<typeof topology.canAcceptPeerRole>>
  ): ReturnType<typeof topology.canAcceptPeerRole> {
    return topology.canAcceptPeerRole(this, ...args);
  }

  /** Check whether this node may forward queries. */
  shouldRelayQueries(
    ...args: OwnerArguments<Parameters<typeof topology.shouldRelayQueries>>
  ): ReturnType<typeof topology.shouldRelayQueries> {
    return topology.shouldRelayQueries(this, ...args);
  }

  /** Check whether this node may forward pings. */
  shouldRelayPings(
    ...args: OwnerArguments<Parameters<typeof topology.shouldRelayPings>>
  ): ReturnType<typeof topology.shouldRelayPings> {
    return topology.shouldRelayPings(this, ...args);
  }

  /** Check whether a connected peer is a leaf. */
  isLeafPeer(
    ...args: OwnerArguments<Parameters<typeof topology.isLeafPeer>>
  ): ReturnType<typeof topology.isLeafPeer> {
    return topology.isLeafPeer(this, ...args);
  }

  /** Check whether a connected peer belongs to the mesh. */
  isMeshPeer(
    ...args: OwnerArguments<Parameters<typeof topology.isMeshPeer>>
  ): ReturnType<typeof topology.isMeshPeer> {
    return topology.isMeshPeer(this, ...args);
  }

  /** Check whether TLS is configured and usable. */
  tlsEnabled(
    ...args: OwnerArguments<Parameters<typeof tlsSupport.tlsEnabled>>
  ): ReturnType<typeof tlsSupport.tlsEnabled> {
    return tlsSupport.tlsEnabled(this, ...args);
  }

  /** Check whether a socket is encrypted. */
  socketUsesTls(
    ...args: OwnerArguments<Parameters<typeof tlsSupport.socketUsesTls>>
  ): ReturnType<typeof tlsSupport.socketUsesTls> {
    return tlsSupport.socketUsesTls(this, ...args);
  }

  /** Check whether the socket supports TLS wrapping. */
  canUpgradeSocketToTls(
    ...args: OwnerArguments<
      Parameters<typeof tlsSupport.canUpgradeSocketToTls>
    >
  ): ReturnType<typeof tlsSupport.canUpgradeSocketToTls> {
    return tlsSupport.canUpgradeSocketToTls(this, ...args);
  }

  /** Check for a requested TLS upgrade token. */
  peerRequestedTlsUpgrade(
    ...args: OwnerArguments<
      Parameters<typeof tlsSupport.peerRequestedTlsUpgrade>
    >
  ): ReturnType<typeof tlsSupport.peerRequestedTlsUpgrade> {
    return tlsSupport.peerRequestedTlsUpgrade(this, ...args);
  }

  /** Check the server's TLS upgrade acknowledgment. */
  peerAcceptedTlsUpgrade(
    ...args: OwnerArguments<
      Parameters<typeof tlsSupport.peerAcceptedTlsUpgrade>
    >
  ): ReturnType<typeof tlsSupport.peerAcceptedTlsUpgrade> {
    return tlsSupport.peerAcceptedTlsUpgrade(this, ...args);
  }

  /** Check the client's final TLS upgrade acknowledgment. */
  clientAcceptedTlsUpgrade(
    ...args: OwnerArguments<
      Parameters<typeof tlsSupport.clientAcceptedTlsUpgrade>
    >
  ): ReturnType<typeof tlsSupport.clientAcceptedTlsUpgrade> {
    return tlsSupport.clientAcceptedTlsUpgrade(this, ...args);
  }

  /** Return the advertised TLS upgrade token. */
  tlsUpgradeToken(
    ...args: OwnerArguments<Parameters<typeof tlsSupport.tlsUpgradeToken>>
  ): ReturnType<typeof tlsSupport.tlsUpgradeToken> {
    return tlsSupport.tlsUpgradeToken(this, ...args);
  }

  /** Negotiate TLS while preserving buffered handshake bytes. */
  upgradeSocketToTls(
    ...args: OwnerArguments<
      Parameters<typeof tlsSupport.upgradeSocketToTls>
    >
  ): ReturnType<typeof tlsSupport.upgradeSocketToTls> {
    return tlsSupport.upgradeSocketToTls(this, ...args);
  }

  /** Build a public summary of a connected peer. */
  peerInfo(
    ...args: OwnerArguments<Parameters<typeof state.peerInfo>>
  ): ReturnType<typeof state.peerInfo> {
    return state.peerInfo(this, ...args);
  }

  /** Choose a usable browsing endpoint for a peer. */
  peerBrowseTarget(
    ...args: OwnerArguments<Parameters<typeof state.peerBrowseTarget>>
  ): ReturnType<typeof state.peerBrowseTarget> {
    return state.peerBrowseTarget(this, ...args);
  }

  /** Count currently connected peers. */
  peerCount(
    ...args: OwnerArguments<Parameters<typeof state.peerCount>>
  ): ReturnType<typeof state.peerCount> {
    return state.peerCount(this, ...args);
  }

  /** Check whether a normalized host is blocked. */
  isBlockedHost(
    ...args: OwnerArguments<Parameters<typeof state.isBlockedHost>>
  ): ReturnType<typeof state.isBlockedHost> {
    return state.isBlockedHost(this, ...args);
  }

  /** Learn peer endpoints and local address observations. */
  absorbHandshakeHeaders(
    ...args: OwnerArguments<
      Parameters<typeof state.absorbHandshakeHeaders>
    >
  ): ReturnType<typeof state.absorbHandshakeHeaders> {
    return state.absorbHandshakeHeaders(this, ...args);
  }

  /** Check whether an endpoint is connected or being dialed. */
  peerDialState(
    ...args: OwnerArguments<Parameters<typeof state.peerDialState>>
  ): ReturnType<typeof state.peerDialState> {
    return state.peerDialState(this, ...args);
  }

  /** Register a negotiated peer and start its session. */
  attachPeer(
    ...args: OwnerArguments<Parameters<typeof transport.attachPeer>>
  ): ReturnType<typeof transport.attachPeer> {
    return transport.attachPeer(this, ...args);
  }

  /** Frame buffered descriptors and dispatch complete messages. */
  consumePeerBuffer(
    ...args: OwnerArguments<Parameters<typeof transport.consumePeerBuffer>>
  ): ReturnType<typeof transport.consumePeerBuffer> {
    return transport.consumePeerBuffer(this, ...args);
  }

  /** Check minimum payload lengths for known descriptors. */
  validateDescriptor(
    ...args: OwnerArguments<
      Parameters<typeof transport.validateDescriptor>
    >
  ): ReturnType<typeof transport.validateDescriptor> {
    return transport.validateDescriptor(this, ...args);
  }

  /** Write a frame through the negotiated compression stream. */
  sendRaw(
    ...args: OwnerArguments<Parameters<typeof transport.sendRaw>>
  ): ReturnType<typeof transport.sendRaw> {
    return transport.sendRaw(this, ...args);
  }

  /** Frame and send a descriptor, then emit its send event. */
  sendToPeer(
    ...args: OwnerArguments<Parameters<typeof transport.sendToPeer>>
  ): ReturnType<typeof transport.sendToPeer> {
    return transport.sendToPeer(this, ...args);
  }
}
