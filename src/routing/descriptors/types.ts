import type { Route, RuntimeConfig } from "../../types";

export type DescriptorLifetime = {
  ttl: number;
  hops: number;
};

export type DescriptorSuppressionInput = {
  closingAfterBye: boolean;
  payloadType: number;
  alreadySeen: boolean;
};

export type ResponseRouteOptions = {
  nodeMode?: RuntimeConfig["nodeMode"];
  forwardInLeaf?: boolean;
};

export type ResponseRouteDecision =
  | { kind: "drop" }
  | { kind: "local" }
  | { kind: "forward"; route: Route };

export type PongCacheEntry = {
  payload: Buffer;
  at: number;
  hops: number;
  sourcePeerKey: string;
};
