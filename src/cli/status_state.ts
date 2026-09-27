import fs from "node:fs/promises";
import path from "node:path";
import { loadDoc, runtimeConfigFor } from "../config/document";
import { DATA_DOWNLOADS_STATE_FILENAME } from "../const";
import { readDownloadStore } from "../downloads/store";
import type { DownloadJob } from "../downloads/types";
import { errMsg } from "../shared";
import { parseShareCatalogManifest } from "../shares/manifest";

export type StatusDownload = {
  job: DownloadJob;
  bytes: number;
  measured: boolean;
  rate?: number;
};

export type StatusState = {
  downloads: StatusDownload[];
  downloadError?: string;
  library?: { count: number; bytes: number };
  libraryError?: string;
  now: number;
};

function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function progress(job: DownloadJob): Promise<StatusDownload> {
  const saved = {
    job,
    bytes: Math.min(job.bytesCompleted, job.fileSize),
    measured: false,
  };
  if (job.status === "complete") return { ...saved, bytes: job.fileSize };
  if (job.status === "verification_failed") return saved;
  try {
    const stat = await fs.stat(job.incompletePath);
    if (!stat.isFile()) return saved;
    return {
      job,
      bytes: Math.min(stat.size, job.fileSize),
      measured: true,
    };
  } catch {
    return saved;
  }
}

async function downloads(dataDir: string): Promise<StatusDownload[]> {
  const doc = await readDownloadStore(
    path.join(dataDir, DATA_DOWNLOADS_STATE_FILENAME),
    { strict: true },
  );
  const rows: StatusDownload[] = [];
  for (let i = 0; i < doc.jobs.length; i += 32)
    rows.push(
      ...(await Promise.all(doc.jobs.slice(i, i + 32).map(progress))),
    );
  return rows;
}

async function library(dataDir: string): Promise<StatusState["library"]> {
  let raw: string;
  try {
    raw = await fs.readFile(
      path.join(dataDir, "share-index.json"),
      "utf8",
    );
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const input: unknown = JSON.parse(raw);
  if (
    !input ||
    typeof input !== "object" ||
    !("version" in input) ||
    input.version !== 1 ||
    !("files" in input) ||
    !Array.isArray(input.files)
  )
    throw new Error("Invalid share index");
  const entries = [...parseShareCatalogManifest(input).values()];
  return {
    count: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}

/** Read existing state and partial-file progress without starting or modifying the client. */
export async function readStatusState(
  configPath: string,
  now = Date.now(),
): Promise<StatusState> {
  const doc = await loadDoc(configPath, { readOnly: true });
  const config = runtimeConfigFor(configPath, doc);
  const [jobs, shares] = await Promise.allSettled([
    downloads(config.dataDir),
    library(config.dataDir),
  ]);
  return {
    now,
    downloads: jobs.status === "fulfilled" ? jobs.value : [],
    downloadError:
      jobs.status === "rejected" ? errMsg(jobs.reason) : undefined,
    library: shares.status === "fulfilled" ? shares.value : undefined,
    libraryError:
      shares.status === "rejected" ? errMsg(shares.reason) : undefined,
  };
}

/** Derive transfer rates only from consecutive observations of growing active partial files. */
export class StatusSampler {
  private previous?: StatusState;

  sample(state: StatusState): StatusState {
    const seconds = this.previous
      ? (state.now - this.previous.now) / 1000
      : 0;
    const previous = new Map(
      this.previous?.downloads.map((row) => [row.job.incompletePath, row]),
    );
    for (const row of state.downloads) {
      const prior = previous.get(row.job.incompletePath);
      row.rate = measuredRate(row, prior, seconds);
    }
    this.previous = state;
    return state;
  }
}

function measuredRate(
  row: StatusDownload,
  prior: StatusDownload | undefined,
  seconds: number,
): number | undefined {
  if (seconds <= 0 || !prior?.measured || !row.measured) return;
  if (row.job.status !== "active" || prior.job.status !== "active") return;
  if (row.bytes >= prior.bytes) return (row.bytes - prior.bytes) / seconds;
}
