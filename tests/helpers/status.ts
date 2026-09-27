import path from "node:path";
import type { DownloadJob } from "../../src/downloads/types";

/** A saved download with a valid source and local-only paths. */
export function statusJob(
  dir: string,
  patch: Partial<DownloadJob> = {},
): DownloadJob {
  return {
    id: "d1",
    status: "active",
    fileName: "recording.flac",
    fileSize: 4096,
    urns: [],
    destPath: path.join(dir, "downloads/recording.flac"),
    incompletePath: path.join(dir, "incomplete/d1.part"),
    bytesCompleted: 1024,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    sources: [
      {
        id: "s1",
        resultNo: 1,
        queryIdHex: "ab".repeat(16),
        queryHops: 1,
        remoteHost: "127.0.0.1",
        remotePort: 1234,
        speedKBps: 10,
        fileIndex: 1,
        fileName: "recording.flac",
        fileSize: 4096,
        serventIdHex: "cd".repeat(16),
        viaPeerKey: "p1",
        attempts: 1,
        failuresWithoutProgress: 0,
      },
    ],
    ...patch,
  };
}
