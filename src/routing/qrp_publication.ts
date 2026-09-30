import type { PeerConnection as Peer } from "../connections/types";
import { QrpTable } from "./qrp";

type PublicationState = {
  lastTable?: QrpTable;
  pending?: Promise<void>;
  cancelled: boolean;
};

type PublicationDependencies = {
  tableForPeer: (peer: Peer) => QrpTable | undefined;
  maxPayloadBytes: () => number;
  send: (peer: Peer, payload: Buffer) => void;
  sleep: (ms: number) => Promise<void>;
};

function tablesEqual(
  previous: QrpTable | undefined,
  next: QrpTable,
): boolean {
  return (
    !!previous &&
    previous.tableSize === next.tableSize &&
    previous.infinity === next.infinity &&
    previous.table.every((value, index) => value === next.table[index])
  );
}

/** Serializes advertisements and remembers the table sent on each connection. */
export class QrpPublisher {
  private readonly states = new Map<Peer, PublicationState>();

  /** Attach table selection and transport collaborators. */
  constructor(private readonly deps: PublicationDependencies) {}

  /** Publish the latest table, skipping an unchanged advertisement. */
  send(peer: Peer): Promise<void> {
    let state = this.states.get(peer);
    if (!state) {
      state = { cancelled: false };
      this.states.set(peer, state);
    }
    const current = state;
    // Read the latest table after earlier updates finish. A failed update must
    // not prevent a later request from retrying the complete advertisement.
    const pending = (current.pending ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.publish(peer, current));
    current.pending = pending;
    return pending.finally(() => {
      if (current.pending === pending) current.pending = undefined;
    });
  }

  private async publish(
    peer: Peer,
    state: PublicationState,
  ): Promise<void> {
    if (state.cancelled || peer.closingAfterBye) return;
    const table = this.deps.tableForPeer(peer);
    if (!table || tablesEqual(state.lastTable, table)) return;

    // Keep a detached snapshot: share scans can mutate the local table while
    // patch chunks are being sent.
    const snapshot = new QrpTable(table.tableSize, table.infinity, 4);
    snapshot.table = table.table.slice();
    // GTK 1.3.1 misindexes received 1-bit patches; 4-bit patches interoperate.
    const patches = snapshot.encodePatchChunks(
      Math.min(this.deps.maxPayloadBytes(), 60 * 1024),
      4,
    );
    // Once RESET is attempted, a failure leaves the remote table uncertain.
    state.lastTable = undefined;
    this.deps.send(peer, snapshot.encodeReset());
    for (const patch of patches) {
      if (state.cancelled || peer.closingAfterBye) return;
      this.deps.send(peer, patch);
      await this.deps.sleep(5);
    }
    if (!state.cancelled) state.lastTable = snapshot;
  }

  /** Cancel queued updates and forget a departed connection's advertisement. */
  drop(peer: Peer): void {
    const state = this.states.get(peer);
    if (state) state.cancelled = true;
    this.states.delete(peer);
  }

  /** Cancel all outstanding publications and release connection state. */
  dispose(): void {
    for (const peer of this.states.keys()) this.drop(peer);
  }
}
