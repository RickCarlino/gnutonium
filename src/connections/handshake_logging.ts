import { ts } from "../shared";
import { describeHandshakeResponse } from "../wire/handshake";
import type { PeerConnections } from "./connections";

/** Emit a handshake lifecycle event. */
export function emitHandshakeDebug(
  connections: PeerConnections,
  direction: "inbound" | "outbound",
  phase: string,
  peer: string,
  message: string,
): void {
  connections.deps.emit({
    type: "HANDSHAKE_DEBUG",
    at: ts(),
    direction,
    phase,
    peer,
    message,
  });
}

/** Describe a sent or received handshake block. */
export function emitHandshakeBlock(
  connections: PeerConnections,
  direction: "inbound" | "outbound",
  phase: string,
  peer: string,
  startLine: string,
  headers: Record<string, string>,
): void {
  emitHandshakeDebug(
    connections,
    direction,
    phase,
    peer,
    describeHandshakeResponse(startLine, headers),
  );
}
