import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DATA_DOWNLOADS_STATE_FILENAME } from "../const";
import {
  ensureDir,
  errMsg,
  fileExists,
  safeFileName,
  ts,
  unique,
} from "../shared";
import { downloadPathCandidate } from "../transfers";
import { DownloadTimeoutError } from "../transfers/errors";
import { buildDownloadRecord } from "../transfers/results";
import type { TransferOptions } from "../transfers/types";
import type { DownloadRecord, SearchHit } from "../types";
import type { DownloadDependencies } from "./dependencies";
import { readDownloadStore, writeDownloadStore } from "./store";
import type {
  DownloadJob,
  DownloadSource,
  DownloadStatus,
  DownloadStoreDoc,
  DownloadTransferMode,
} from "./types";
import { verifySha1Urn } from "./verification";

type ActiveDownload = {
  controller: AbortController;
  sourceId: string;
};

function cloneSource(source: DownloadSource): DownloadSource {
  return {
    ...source,
    urns: source.urns ? [...source.urns] : [],
    metadata: source.metadata ? [...source.metadata] : undefined,
  };
}

function cloneJob(job: DownloadJob): DownloadJob {
  return {
    ...job,
    urns: [...job.urns],
    sources: job.sources.map((source) => cloneSource(source)),
  };
}

function sourceKey(
  source: Pick<
    DownloadSource,
    "remoteHost" | "remotePort" | "fileIndex" | "serventIdHex"
  >,
): string {
  return [
    source.remoteHost,
    source.remotePort,
    source.fileIndex,
    source.serventIdHex,
  ].join("|");
}

function sourceFromHit(hit: SearchHit, id: string): DownloadSource {
  return {
    id,
    resultNo: hit.resultNo,
    queryIdHex: hit.queryIdHex,
    queryHops: hit.queryHops,
    remoteHost: hit.remoteHost,
    remotePort: hit.remotePort,
    speedKBps: hit.speedKBps,
    fileIndex: hit.fileIndex,
    fileName: hit.fileName,
    fileSize: hit.fileSize,
    serventIdHex: hit.serventIdHex,
    viaPeerKey: hit.viaPeerKey,
    urns: hit.urns ? [...hit.urns] : [],
    metadata: hit.metadata ? [...hit.metadata] : [],
    attempts: 0,
    failuresWithoutProgress: 0,
    ...(hit.sha1Urn ? { sha1Urn: hit.sha1Urn } : {}),
    ...(hit.vendorCode ? { vendorCode: hit.vendorCode } : {}),
    ...(hit.needsPush != null ? { needsPush: hit.needsPush } : {}),
    ...(hit.busy != null ? { busy: hit.busy } : {}),
  };
}

function hitFromSource(source: DownloadSource): SearchHit {
  return {
    resultNo: source.resultNo,
    queryIdHex: source.queryIdHex,
    queryHops: source.queryHops,
    remoteHost: source.remoteHost,
    remotePort: source.remotePort,
    speedKBps: source.speedKBps,
    fileIndex: source.fileIndex,
    fileName: source.fileName,
    fileSize: source.fileSize,
    serventIdHex: source.serventIdHex,
    viaPeerKey: source.viaPeerKey,
    urns: source.urns ? [...source.urns] : [],
    metadata: source.metadata ? [...source.metadata] : [],
    ...(source.sha1Urn ? { sha1Urn: source.sha1Urn } : {}),
    ...(source.vendorCode ? { vendorCode: source.vendorCode } : {}),
    ...(source.needsPush != null ? { needsPush: source.needsPush } : {}),
    ...(source.busy != null ? { busy: source.busy } : {}),
  };
}

function terminalStatus(status: DownloadStatus): boolean {
  return status === "complete" || status === "verification_failed";
}

function sizeMismatchMessage(expected: number, actual: number): string {
  return `download size mismatch: expected ${expected} bytes, got ${actual}`;
}

async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

async function moveFile(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  try {
    // Creating a link is atomic and refuses an existing destination, including
    // dangling symlinks. A preflight existence check alone cannot ensure this.
    await fsp.link(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
  }
  await fsp.unlink(src);
}

/** Owns persisted jobs, retries, and transfer scheduling. */
export class DownloadManager {
  private doc: DownloadStoreDoc = { version: 1, nextId: 1, jobs: [] };
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private savePromise: Promise<void> = Promise.resolve();
  private active = new Map<string, ActiveDownload>();
  private removing = new Set<string>();
  private wakeTimer?: NodeJS.Timeout;
  private running = false;

  private readonly history: DownloadRecord[] = [];
  private readonly store: NonNullable<DownloadDependencies["store"]>;

  /** Attach the transfer, clock, and storage dependencies. */
  constructor(private readonly deps: DownloadDependencies) {
    this.store = deps.store ?? {
      read: readDownloadStore,
      write: writeDownloadStore,
    };
  }

  /** Return a detached snapshot of completed transfers. */
  getHistory(): DownloadRecord[] {
    return structuredClone(this.history);
  }

  private storePath(): string {
    return path.join(
      this.deps.config().dataDir,
      DATA_DOWNLOADS_STATE_FILENAME,
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        this.doc = await this.store.read(this.storePath());
        await this.normalizeLoadedJobs();
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  private async normalizeLoadedJobs(): Promise<void> {
    let changed = false;
    for (const job of this.doc.jobs) {
      if (job.status === "active" || job.status === "verifying") {
        job.status = "queued";
        job.activeSourceId = undefined;
        job.updatedAt = ts();
        changed = true;
      }
      if (job.status !== "complete") {
        const size = await fileSize(job.incompletePath);
        if (size != null && size !== job.bytesCompleted) {
          job.bytesCompleted = size;
          changed = true;
        }
      }
    }
    if (changed) await this.save();
  }

  private async save(): Promise<void> {
    const write = () => this.store.write(this.storePath(), this.doc);
    this.savePromise = this.savePromise.then(write, write);
    await this.savePromise;
  }

  /** Load saved jobs and start scheduling transfers. */
  async start(): Promise<void> {
    await this.ensureLoaded();
    this.running = true;
    this.schedule();
  }

  /** Abort active transfers and persist queued jobs. */
  async stop(): Promise<void> {
    await this.ensureLoaded();
    this.running = false;
    this.cancelWake();
    for (const [jobId, active] of this.active) {
      const job = this.jobById(jobId);
      if (job) {
        job.status = "queued";
        job.activeSourceId = undefined;
        job.updatedAt = ts();
      }
      active.controller.abort();
    }
    await this.save();
  }

  /** Save the current download queue. */
  async persist(): Promise<void> {
    await this.ensureLoaded();
    await this.save();
  }

  /** Return detached snapshots of download jobs. */
  getJobs(): DownloadJob[] {
    return this.doc.jobs.map((job) => cloneJob(job));
  }

  /** Create a job or add a source to an existing job. */
  async queue(
    hit: SearchHit,
    destOverride?: string,
  ): Promise<DownloadJob> {
    await this.ensureLoaded();
    const job =
      this.findMergeTarget(hit) ||
      (await this.createJob(hit, destOverride));
    this.addSource(job, hit);
    if (!terminalStatus(job.status) && job.status !== "paused") {
      job.status = "queued";
      job.error = undefined;
    }
    job.updatedAt = ts();
    await this.save();
    this.deps.emit({
      type: "DOWNLOAD_QUEUED",
      at: ts(),
      jobId: job.id,
      resultNo: hit.resultNo,
      fileName: job.fileName,
      destPath: job.destPath,
    });
    this.schedule();
    return cloneJob(job);
  }

  /** Pause a job and abort its active transfer. */
  async pause(jobId: string): Promise<DownloadJob> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    if (job.status !== "complete") {
      job.status = "paused";
      job.error = undefined;
      job.updatedAt = ts();
      job.activeSourceId = undefined;
      this.active.get(job.id)?.controller.abort();
      await this.save();
      this.deps.emit({
        type: "DOWNLOAD_PAUSED",
        at: ts(),
        jobId: job.id,
        fileName: job.fileName,
      });
    }
    return cloneJob(job);
  }

  /** Reset retry state and requeue an unfinished job. */
  async resume(jobId: string): Promise<DownloadJob> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    if (job.status === "complete") return cloneJob(job);
    if (job.status === "verification_failed") {
      await fsp.rm(job.incompletePath, { force: true });
      job.bytesCompleted = 0;
    }
    for (const source of job.sources) {
      source.failuresWithoutProgress = 0;
      source.cooldownUntil = undefined;
      source.lastError = undefined;
    }
    job.status = "queued";
    job.error = undefined;
    job.activeSourceId = undefined;
    job.updatedAt = ts();
    await this.save();
    this.deps.emit({
      type: "DOWNLOAD_RESUMED",
      at: ts(),
      jobId: job.id,
      fileName: job.fileName,
    });
    this.schedule();
    return cloneJob(job);
  }

  /** Forget a job and delete its incomplete file. */
  async remove(jobId: string): Promise<void> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    this.removing.add(job.id);
    this.active.get(job.id)?.controller.abort();
    this.doc.jobs = this.doc.jobs.filter(
      (candidate) => candidate.id !== job.id,
    );
    await fsp.rm(job.incompletePath, { force: true });
    await this.save();
    this.deps.emit({
      type: "DOWNLOAD_REMOVED",
      at: ts(),
      jobId: job.id,
      fileName: job.fileName,
    });
  }

  private findMergeTarget(hit: SearchHit): DownloadJob | undefined {
    const urn = hit.sha1Urn?.toLowerCase();
    if (!urn) return undefined;
    return this.doc.jobs.find((job) => job.sha1Urn?.toLowerCase() === urn);
  }

  private async createJob(
    hit: SearchHit,
    destOverride?: string,
  ): Promise<DownloadJob> {
    const id = `d${this.doc.nextId++}`;
    const now = ts();
    const destPath = destOverride
      ? path.resolve(destOverride)
      : await this.nextDefaultDestPath(hit.fileName);
    const incompletePath =
      destOverride && (await fileExists(destPath))
        ? destPath
        : path.join(
            this.deps.config().incompleteDownloadsDir,
            `${id}-${safeFileName(hit.fileName)}.part`,
          );
    const job: DownloadJob = {
      id,
      status: "queued",
      fileName: hit.fileName,
      fileSize: hit.fileSize,
      urns: unique(hit.urns || []),
      destPath,
      incompletePath,
      bytesCompleted: 0,
      createdAt: now,
      updatedAt: now,
      sources: [],
      ...(hit.sha1Urn ? { sha1Urn: hit.sha1Urn } : {}),
    };
    this.doc.jobs.push(job);
    return job;
  }

  private addSource(job: DownloadJob, hit: SearchHit): void {
    const existingKeys = new Set(
      job.sources.map((source) => sourceKey(source)),
    );
    const candidate = sourceFromHit(hit, `s${job.sources.length + 1}`);
    if (!existingKeys.has(sourceKey(candidate)))
      job.sources.push(candidate);
    job.urns = unique([...job.urns, ...(hit.urns || [])]);
    if (!job.sha1Urn && hit.sha1Urn) job.sha1Urn = hit.sha1Urn;
  }

  private async nextDefaultDestPath(fileName: string): Promise<string> {
    const basePath = path.resolve(
      path.join(this.deps.config().downloadsDir, safeFileName(fileName)),
    );
    let suffixNo = 1;
    for (;;) {
      const candidate = downloadPathCandidate(basePath, suffixNo);
      const used = this.doc.jobs.some(
        (job) => path.resolve(job.destPath) === candidate,
      );
      if (!used && !(await fileExists(candidate))) return candidate;
      suffixNo++;
    }
  }

  private jobById(jobId: string): DownloadJob | undefined {
    return this.doc.jobs.find((job) => job.id === jobId);
  }

  private requireJob(jobId: string): DownloadJob {
    const job = this.jobById(jobId);
    if (!job) throw new Error(`no such download ${jobId}`);
    return job;
  }

  private activeHostCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [jobId, active] of this.active) {
      const job = this.jobById(jobId);
      const source = job?.sources.find(
        (candidate) => candidate.id === active.sourceId,
      );
      if (!source) continue;
      counts.set(
        source.remoteHost,
        (counts.get(source.remoteHost) || 0) + 1,
      );
    }
    return counts;
  }

  private nextSource(
    job: DownloadJob,
    hostCounts: Map<string, number>,
    nowMs: number,
  ): DownloadSource | undefined {
    return job.sources.find((source) => {
      if (
        source.failuresWithoutProgress >=
        this.deps.config().downloadRetryLimit
      )
        return false;
      if (source.cooldownUntil && source.cooldownUntil > nowMs)
        return false;
      const hostCount = hostCounts.get(source.remoteHost) || 0;
      return hostCount < this.deps.config().downloadMaxActivePerHost;
    });
  }

  private soonestCooldown(): number | undefined {
    const nowMs = this.deps.now();
    let soonest: number | undefined;
    for (const job of this.doc.jobs) {
      if (job.status !== "queued") continue;
      for (const source of job.sources) {
        if (!source.cooldownUntil || source.cooldownUntil <= nowMs)
          continue;
        soonest =
          soonest == null
            ? source.cooldownUntil
            : Math.min(soonest, source.cooldownUntil);
      }
    }
    return soonest;
  }

  private cancelWake(): void {
    if (!this.wakeTimer) return;
    this.deps.cancel(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private scheduleWake(): void {
    if (this.wakeTimer) return;
    const soonest = this.soonestCooldown();
    if (soonest == null) return;
    const delay = Math.max(1, soonest - this.deps.now());
    this.wakeTimer = this.deps.schedule(delay, () => {
      this.wakeTimer = undefined;
      this.schedule();
    });
  }

  private canSchedule(): boolean {
    return this.loaded && this.running;
  }

  private scheduleJob(
    job: DownloadJob,
    hostCounts: Map<string, number>,
    nowMs: number,
  ): void {
    if (job.status !== "queued" || this.active.has(job.id)) return;
    const source = this.nextSource(job, hostCounts, nowMs);
    if (!source) return;
    hostCounts.set(
      source.remoteHost,
      (hostCounts.get(source.remoteHost) || 0) + 1,
    );
    this.startJob(job, source);
  }

  private schedule(): void {
    if (!this.canSchedule()) return;
    this.cancelWake();
    const hostCounts = this.activeHostCounts();
    const nowMs = this.deps.now();
    for (const job of this.doc.jobs) {
      if (this.active.size >= this.deps.config().downloadQueueSize) break;
      this.scheduleJob(job, hostCounts, nowMs);
    }
    this.scheduleWake();
  }

  private startJob(job: DownloadJob, source: DownloadSource): void {
    const controller = new AbortController();
    this.active.set(job.id, { controller, sourceId: source.id });
    job.status = "active";
    job.activeSourceId = source.id;
    job.error = undefined;
    job.updatedAt = ts();
    source.attempts++;
    source.cooldownUntil = undefined;
    source.lastAttemptAt = job.updatedAt;
    source.lastError = undefined;
    void this.save();
    this.deps.emit({
      type: "DOWNLOAD_STARTED",
      at: ts(),
      jobId: job.id,
      fileName: job.fileName,
      remoteHost: source.remoteHost,
      remotePort: source.remotePort,
    });
    void this.runJob(job.id, source.id, controller).catch((error) => {
      this.deps.onError(error);
    });
  }

  private async runJob(
    jobId: string,
    sourceId: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      await this.transferJob(jobId, sourceId, controller.signal);
    } finally {
      this.active.delete(jobId);
      this.removing.delete(jobId);
      this.schedule();
    }
  }

  private async transferJob(
    jobId: string,
    sourceId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const transfer = this.transferState(jobId, sourceId);
    if (!transfer) return;
    const { job, source } = transfer;
    let startBytes = job.bytesCompleted;
    try {
      await ensureDir(path.dirname(job.incompletePath));
      startBytes = (await fileSize(job.incompletePath)) ?? 0;
      const mode = await this.transferFromSource(job, source, signal);
      if (this.removing.has(job.id) || job.status === "paused") return;
      await this.completeJob(job, source, mode);
    } catch (error) {
      if (this.shouldIgnoreTransferFailure(job)) return;
      await this.failSource(job, source, error, startBytes);
    }
  }

  private transferState(
    jobId: string,
    sourceId: string,
  ): { job: DownloadJob; source: DownloadSource } | undefined {
    const job = this.jobById(jobId);
    const source = job?.sources.find(
      (candidate) => candidate.id === sourceId,
    );
    return job && source ? { job, source } : undefined;
  }

  private shouldIgnoreTransferFailure(job: DownloadJob): boolean {
    return (
      !this.running || this.removing.has(job.id) || job.status === "paused"
    );
  }

  private async transferFromSource(
    job: DownloadJob,
    source: DownloadSource,
    signal: AbortSignal,
  ): Promise<DownloadTransferMode> {
    const hit = hitFromSource(source);
    const options: TransferOptions = {
      signal,
      onProgress: ({ bytesCompleted }) => {
        job.bytesCompleted = bytesCompleted;
        job.updatedAt = ts();
      },
    };
    try {
      await this.deps.transfers.direct(hit, job.incompletePath, options);
      return "direct";
    } catch (error) {
      if (signal.aborted) throw error;
      this.deps.emit({
        type: "DOWNLOAD_DIRECT_FAILED",
        at: ts(),
        resultNo: source.resultNo,
        fileName: job.fileName,
        destPath: job.incompletePath,
        remoteHost: source.remoteHost,
        remotePort: source.remotePort,
        message: errMsg(error),
      });
      if (
        error instanceof DownloadTimeoutError &&
        error.phase !== "connect"
      ) {
        throw error;
      }
      try {
        await this.deps.transfers.push(hit, job.incompletePath, options);
        return "push";
      } catch (pushError) {
        if (signal.aborted) throw pushError;
        throw new Error(
          `direct: ${errMsg(error)}; push: ${errMsg(pushError)}`,
        );
      }
    }
  }

  private async completeJob(
    job: DownloadJob,
    source: DownloadSource,
    mode: DownloadTransferMode,
  ): Promise<void> {
    job.status = "verifying";
    job.activeSourceId = undefined;
    job.updatedAt = ts();
    await this.save();
    if (await this.rejectSizeMismatch(job, source)) return;
    if (this.deps.config().verifyDownloads && job.sha1Urn) {
      const ok = await verifySha1Urn(job.incompletePath, job.sha1Urn);
      if (!ok) {
        job.status = "verification_failed";
        job.error = "SHA1 verification failed";
        job.updatedAt = ts();
        await this.save();
        this.deps.emit({
          type: "DOWNLOAD_VERIFICATION_FAILED",
          at: ts(),
          jobId: job.id,
          fileName: job.fileName,
          destPath: job.incompletePath,
        });
        return;
      }
    }
    const inPlace =
      path.resolve(job.incompletePath) === path.resolve(job.destPath);
    const finalPath = inPlace
      ? path.resolve(job.destPath)
      : await this.availableFinalPath(job.destPath);
    if (!inPlace) await moveFile(job.incompletePath, finalPath);
    job.destPath = finalPath;
    job.bytesCompleted = (await fileSize(finalPath)) ?? job.fileSize;
    job.status = "complete";
    source.failuresWithoutProgress = 0;
    job.completedAt = ts();
    job.updatedAt = job.completedAt;
    await this.save();
    const hit = hitFromSource(source);
    this.history.push(
      buildDownloadRecord(hit, finalPath, mode, job.completedAt),
    );
    this.deps.emit({
      type: "DOWNLOAD_SUCCEEDED",
      at: job.completedAt,
      mode,
      resultNo: source.resultNo,
      fileName: job.fileName,
      destPath: finalPath,
      remoteHost: source.remoteHost,
      remotePort: source.remotePort,
    });
  }

  private async rejectSizeMismatch(
    job: DownloadJob,
    source: DownloadSource,
  ): Promise<boolean> {
    if (job.fileSize <= 0) return false;
    const actualBytes = (await fileSize(job.incompletePath)) ?? 0;
    job.bytesCompleted = actualBytes;
    if (actualBytes === job.fileSize) return false;
    source.failuresWithoutProgress = this.deps.config().downloadRetryLimit;
    if (path.resolve(job.incompletePath) !== path.resolve(job.destPath)) {
      await fsp.rm(job.incompletePath, { force: true });
      job.bytesCompleted = 0;
    }
    await this.failSource(
      job,
      source,
      new Error(sizeMismatchMessage(job.fileSize, actualBytes)),
    );
    return true;
  }

  private async availableFinalPath(initialPath: string): Promise<string> {
    const basePath = path.resolve(initialPath);
    let suffixNo = 1;
    for (;;) {
      const candidate = downloadPathCandidate(basePath, suffixNo);
      if (!(await fileExists(candidate))) return candidate;
      suffixNo++;
    }
  }

  private async failSource(
    job: DownloadJob,
    source: DownloadSource,
    error: unknown,
    startBytes?: number,
  ): Promise<void> {
    const message = errMsg(error);
    source.lastError = message;
    source.cooldownUntil =
      this.deps.now() + this.deps.config().downloadRetryBackoffSec * 1000;
    job.activeSourceId = undefined;
    job.bytesCompleted = (await fileSize(job.incompletePath)) ?? 0;
    if (startBytes !== undefined) {
      source.failuresWithoutProgress =
        job.bytesCompleted > startBytes
          ? 0
          : source.failuresWithoutProgress + 1;
    }
    const canRetry = job.sources.some(
      (candidate) =>
        candidate.failuresWithoutProgress <
        this.deps.config().downloadRetryLimit,
    );
    job.status = canRetry ? "queued" : "failed";
    job.error = canRetry ? undefined : message;
    job.updatedAt = ts();
    await this.save();
    if (!canRetry) {
      this.deps.emit({
        type: "DOWNLOAD_FAILED",
        at: ts(),
        jobId: job.id,
        fileName: job.fileName,
        message,
      });
    }
  }
}
