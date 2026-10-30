import type { SearchHit } from "../types";

export type DownloadMode = "direct" | "push";

export type DirectDownloadPlanInput = Pick<
  SearchHit,
  "fileIndex" | "fileName" | "remoteHost" | "remotePort" | "sha1Urn"
> & {
  existingBytes: number;
  serveUriRes: boolean;
};

export type DirectDownloadAttempt =
  | {
      kind: "uri-res";
      urn: string;
      existingBytes: number;
      fallbackOnFailure: true;
    }
  | {
      kind: "get";
      fileIndex: number;
      fileName: string;
      existingBytes: number;
      fallbackOnFailure: false;
    };

export type HttpDownloadProgress = {
  headerDone: boolean;
  remaining: number;
  finalStart: number;
  bodyBytes: number;
};

export type HttpDownloadEndDecision =
  { kind: "complete" } | { kind: "incomplete"; message: string };

export type HttpDownloadRange = {
  start: number;
  end: number;
  total?: number;
};

export type HttpDownloadResult = {
  range?: HttpDownloadRange;
  connectionClose?: true;
  destPath: string;
  bytes: number;
  label: string;
};

type TransferProgress = {
  bytesCompleted: number;
};

export type TransferOptions = {
  expectedSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
};
