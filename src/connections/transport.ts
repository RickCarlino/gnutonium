import type net from "node:net";
import zlib from "node:zlib";
import { HEADER_LEN, TYPE, TYPE_NAME } from "../const";
import { ts } from "../shared";
import type { PeerCapabilities, PeerRole } from "../types";
import { buildHeader, parseHeader } from "../wire/codec";
import type { PeerConnections } from "./connections";
import { PeerSession } from "./session";
import type { PeerConnection as Peer } from "./types";

/** Name a descriptor type, falling back to hexadecimal. */
export function descriptorTypeName(payloadType: number): string {
  return TYPE_NAME[payloadType] || `0x${payloadType.toString(16)}`;
}

/** Register a negotiated peer and start its session. */
export function attachPeer(
  connections: PeerConnections,
  socket: net.Socket,
  outbound: boolean,
  remoteLabel: string,
  role: PeerRole,
  capabilities: PeerCapabilities,
  initialBuf: Buffer = Buffer.alloc(0),
  dialTarget?: string,
): Peer {
  const connectedAt = connections.now();
  const key = `p${++connections.peerSeq}`;
  const peer: Peer = {
    key,
    socket,
    buf: Buffer.alloc(0),
    outbound,
    remoteLabel,
    dialTarget,
    role,
    capabilities,
    connectedAt,
  };
  connections.peers.set(key, peer);
  const session = new PeerSession(peer, {
    consume: (peer) => connections.consumePeerBuffer(peer),
    scheduler: connections.deps.scheduler,
    dropped: (peer, message) => {
      connections.deps.discovery.markPeerSeenIfStable(peer);
      connections.peers.delete(peer.key);
      connections.sessions.delete(peer.key);
      connections.deps.discovery.refreshGWebCacheReport();
      connections.deps.routing.dropped(peer);
      if (!connections.stopped)
        connections.deps.emit({
          type: "PEER_DROPPED",
          at: ts(),
          peer: connections.peerInfo(peer),
          message,
        });
    },
  });
  connections.sessions.set(key, session);
  session.start(initialBuf);

  connections.deps.discovery.rememberPeerAddresses(peer);
  connections.deps.discovery.refreshGWebCacheReport();
  connections.deps.emit({
    type: "PEER_CONNECTED",
    at: ts(),
    peer: connections.peerInfo(peer),
  });
  session.schedule(300, () => connections.deps.routing.ping(peer, 1));
  if (
    connections.config().enableQrp &&
    (capabilities.queryRoutingVersion ||
      capabilities.ultrapeerQueryRoutingVersion)
  ) {
    session.schedule(
      500,
      () =>
        void connections.deps.routing.publishQrp(peer).catch(() => void 0),
    );
  }
  return peer;
}

/** Frame buffered descriptors and dispatch complete messages. */
export function consumePeerBuffer(
  connections: PeerConnections,
  peer: Peer,
): void {
  while (peer.buf.length >= HEADER_LEN) {
    const hdr = parseHeader(peer.buf.subarray(0, HEADER_LEN));
    if (hdr.payloadLength > connections.config().maxPayloadBytes) {
      throw new Error(`payload too large: ${hdr.payloadLength}`);
    }
    if (peer.buf.length < HEADER_LEN + hdr.payloadLength) return;
    const payload = peer.buf.subarray(
      HEADER_LEN,
      HEADER_LEN + hdr.payloadLength,
    );
    peer.buf = peer.buf.subarray(HEADER_LEN + hdr.payloadLength);
    if (!connections.validateDescriptor(hdr.payloadType, payload)) {
      throw new Error(
        `invalid ${descriptorTypeName(hdr.payloadType)} payload`,
      );
    }
    if (hdr.payloadType !== TYPE.QUERY) {
      hdr.ttl = Math.min(hdr.ttl, connections.config().maxTtl);
    }
    connections.deps.emit({
      type: "PEER_MESSAGE_RECEIVED",
      at: ts(),
      peer: connections.peerInfo(peer),
      payloadType: hdr.payloadType,
      payloadTypeName: descriptorTypeName(hdr.payloadType),
      descriptorIdHex: hdr.descriptorIdHex,
      ttl: hdr.ttl,
      hops: hdr.hops,
      payloadLength: payload.length,
    });
    connections.deps.routing.descriptor(peer, hdr, payload);
  }
}

/** Check minimum payload lengths for known descriptors. */
export function validateDescriptor(
  _connections: PeerConnections,
  payloadType: number,
  payload: Buffer,
): boolean {
  switch (payloadType) {
    case TYPE.PING:
      return true;
    case TYPE.PONG:
      return payload.length >= 14;
    case TYPE.BYE:
      return payload.length >= 2;
    case TYPE.ROUTE_TABLE_UPDATE:
      return payload.length >= 1;
    case TYPE.PUSH:
      return payload.length >= 26;
    case TYPE.QUERY:
      return payload.length >= 3;
    case TYPE.QUERY_HIT:
      return payload.length >= 27;
    default:
      return true;
  }
}

/** Write a frame through the negotiated compression stream. */
export function sendRaw(
  _connections: PeerConnections,
  peer: Peer,
  frame: Buffer,
): void {
  if (peer.deflater) {
    peer.deflater.write(frame);
    peer.deflater.flush(zlib.constants.Z_SYNC_FLUSH);
    return;
  }
  peer.socket.write(frame);
}

/** Frame and send a descriptor, then emit its send event. */
export function sendToPeer(
  connections: PeerConnections,
  peer: Peer,
  payloadType: number,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
): void {
  if (peer.closingAfterBye && payloadType !== TYPE.BYE) return;
  const frame = buildHeader(descriptorId, payloadType, ttl, hops, payload);
  connections.sendRaw(peer, frame);
  connections.deps.emit({
    type: "PEER_MESSAGE_SENT",
    at: ts(),
    peer: connections.peerInfo(peer),
    payloadType,
    payloadTypeName: descriptorTypeName(payloadType),
    descriptorIdHex: descriptorId.toString("hex"),
    ttl,
    hops,
    payloadLength: payload.length,
  });
}
