import type net from "node:net";
import type zlib from "node:zlib";
import type { PeerCapabilities, PeerRole, RemoteQrpState } from "../types";

export type ProbeCtx = {
  socket: net.Socket;
  buf: Buffer;
  receivedBytes: number;
  startedAtMs: number;
  mode: "undecided" | "await-final-0.6" | "done";
  requestHeaders?: Record<string, string>;
  serverHeaders?: Record<string, string>;
  cancelDeadline?: () => void;
  onData?: (chunk: string | Buffer) => void;
  onEnd?: () => void;
  onClose?: (hadError: boolean) => void;
  onError?: (error: unknown) => void;
};

export type Peer = PeerConnection & {
  remoteQrp: RemoteQrpState;
  lastPingAt: number;
};

export type PeerConnection = {
  key: string;
  socket: net.Socket;
  buf: Buffer;
  outbound: boolean;
  dialTarget?: string;
  remoteLabel: string;
  role: PeerRole;
  capabilities: PeerCapabilities;
  inflater?: zlib.Inflate;
  deflater?: zlib.Deflate;
  connectedAt: number;
  closingAfterBye?: boolean;
};
