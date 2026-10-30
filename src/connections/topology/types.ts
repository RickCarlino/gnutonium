import type { PeerRole } from "../../types";

type TopologyNodeMode = "leaf" | "ultrapeer";

export type PeerRoleSummary = {
  role: PeerRole;
};

export type PeerRoleClassification = {
  localMode: TopologyNodeMode;
  remoteIsUltrapeer?: boolean;
};

export type TopologySlotState = {
  nodeMode: TopologyNodeMode;
  maxUltrapeerConnections: number;
  maxLeafConnections: number;
  connectedMeshPeerCount: number;
  connectedLeafCount: number;
  dialingCount: number;
};

export type AdmissionResult =
  { ok: true } | { ok: false; code: number; reason: string };
