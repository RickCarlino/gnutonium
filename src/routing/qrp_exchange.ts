import type { PeerConnection as Peer } from "../connections/types";
import { errMsg } from "../shared";
import { parseRouteTableUpdate } from "../wire/codec";
import {
  DEFAULT_QRP_ENTRY_BITS,
  QrpTable,
  validateRemoteQrpPatchSequence,
  validateRemoteQrpReset,
} from "./qrp";
import { sendPublishedQrpToMeshPeers } from "./queries";
import type { MessageRouter } from "./router";

function rejectQrpUpdate(
  router: MessageRouter,
  peer: Peer,
  reason: string,
): void {
  if (peer.capabilities.supportsBye) router.sendBye(peer, 413, reason);
  else peer.socket.end();
}

/** Validate and apply a peer's QRP reset or patch. */
export function onRouteTableUpdate(
  router: MessageRouter,
  peer: Peer,
  payload: Buffer,
): void {
  let msg: ReturnType<typeof parseRouteTableUpdate>;
  try {
    msg = parseRouteTableUpdate(payload);
  } catch (error) {
    rejectQrpUpdate(router, peer, errMsg(error));
    return;
  }
  if (msg.variant === "reset") {
    const rejection = validateRemoteQrpReset(msg);
    if (rejection) {
      rejectQrpUpdate(router, peer, rejection);
      return;
    }
    router.peerState(peer).qrp.resetSeen = true;
    router.peerState(peer).qrp.tableSize = msg.tableLength;
    router.peerState(peer).qrp.infinity = msg.infinity;
    router.peerState(peer).qrp.entryBits = DEFAULT_QRP_ENTRY_BITS;
    router.peerState(peer).qrp.table = null;
    router.peerState(peer).qrp.seqSize = 0;
    router.peerState(peer).qrp.parts.clear();
    return;
  }
  const rejection = validateRemoteQrpPatchSequence(
    router.peerState(peer).qrp,
    msg,
  );
  if (rejection) {
    rejectQrpUpdate(router, peer, rejection);
    return;
  }
  router.peerState(peer).qrp.seqSize = msg.seqSize;
  router.peerState(peer).qrp.compressor = msg.compressor;
  router.peerState(peer).qrp.entryBits = msg.entryBits;
  router.peerState(peer).qrp.parts.set(msg.seqNo, Buffer.from(msg.data));
  const applyRejection = QrpTable.applyPatch(router.peerState(peer).qrp);
  if (applyRejection) {
    rejectQrpUpdate(router, peer, applyRejection);
    return;
  }
  if (router.peerState(peer).qrp.table && peer.role === "leaf")
    sendPublishedQrpToMeshPeers(router);
}
