import fsp from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists } from "../shared";
import type {
  DownloadJob,
  DownloadSource,
  DownloadStatus,
  DownloadStoreDoc,
} from "./types";

const DOWNLOAD_STORE_VERSION = 1;

const DOWNLOAD_STATUSES = new Set<DownloadStatus>([
  "queued",
  "active",
  "paused",
  "verifying",
  "complete",
  "failed",
  "verification_failed",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string",
  );
}

function nonNegativeNumber(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return 0;
  return Math.floor(numberValue);
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  return Math.floor(numberValue);
}

function normalizeStatus(value: unknown): DownloadStatus {
  return typeof value === "string" &&
    DOWNLOAD_STATUSES.has(value as DownloadStatus)
    ? (value as DownloadStatus)
    : "queued";
}

type RequiredSourceFields = Pick<
  DownloadSource,
  | "queryIdHex"
  | "remoteHost"
  | "remotePort"
  | "fileIndex"
  | "fileName"
  | "fileSize"
  | "serventIdHex"
  | "viaPeerKey"
>;

type RequiredJobFields = Pick<
  DownloadJob,
  | "id"
  | "fileName"
  | "destPath"
  | "incompletePath"
  | "createdAt"
  | "updatedAt"
>;

function requiredSourceFields(
  input: Record<string, unknown>,
): RequiredSourceFields | undefined {
  const remoteHost = nonEmptyString(input.remoteHost);
  const fileName = nonEmptyString(input.fileName);
  const serventIdHex = nonEmptyString(input.serventIdHex);
  const viaPeerKey = nonEmptyString(input.viaPeerKey);
  const queryIdHex = nonEmptyString(input.queryIdHex);
  const remotePort = nonNegativeNumber(input.remotePort);
  const fileIndex = nonNegativeNumber(input.fileIndex);
  const fileSize = nonNegativeNumber(input.fileSize);
  if (
    !remoteHost ||
    !remotePort ||
    !fileIndex ||
    !fileName ||
    !serventIdHex ||
    !viaPeerKey ||
    !queryIdHex
  ) {
    return undefined;
  }
  return {
    queryIdHex,
    remoteHost,
    remotePort,
    fileIndex,
    fileName,
    fileSize,
    serventIdHex,
    viaPeerKey,
  };
}

function applyOptionalSourceFields(
  source: DownloadSource,
  input: Record<string, unknown>,
): void {
  const sha1Urn = nonEmptyString(input.sha1Urn);
  const vendorCode = nonEmptyString(input.vendorCode);
  const lastAttemptAt = nonEmptyString(input.lastAttemptAt);
  const lastError = nonEmptyString(input.lastError);
  const cooldownUntil = optionalNonNegativeNumber(input.cooldownUntil);
  if (sha1Urn) source.sha1Urn = sha1Urn;
  if (vendorCode) source.vendorCode = vendorCode;
  if (typeof input.needsPush === "boolean")
    source.needsPush = input.needsPush;
  if (typeof input.busy === "boolean") source.busy = input.busy;
  if (lastAttemptAt) source.lastAttemptAt = lastAttemptAt;
  if (lastError) source.lastError = lastError;
  if (cooldownUntil != null) source.cooldownUntil = cooldownUntil;
}

function normalizeSource(
  raw: unknown,
  fallbackIndex: number,
): DownloadSource | undefined {
  const input = asRecord(raw);
  if (!input) return undefined;
  const required = requiredSourceFields(input);
  if (!required) return undefined;
  const source: DownloadSource = {
    id: nonEmptyString(input.id) || `s${fallbackIndex}`,
    resultNo: nonNegativeNumber(input.resultNo),
    queryIdHex: required.queryIdHex,
    queryHops: nonNegativeNumber(input.queryHops),
    remoteHost: required.remoteHost,
    remotePort: required.remotePort,
    speedKBps: nonNegativeNumber(input.speedKBps),
    fileIndex: required.fileIndex,
    fileName: required.fileName,
    fileSize: required.fileSize,
    serventIdHex: required.serventIdHex,
    viaPeerKey: required.viaPeerKey,
    urns: stringArray(input.urns),
    metadata: stringArray(input.metadata),
    attempts: nonNegativeNumber(input.attempts),
    failuresWithoutProgress: nonNegativeNumber(
      input.failuresWithoutProgress,
    ),
  };
  applyOptionalSourceFields(source, input);
  return source;
}

function requiredJobFields(
  input: Record<string, unknown>,
): RequiredJobFields | undefined {
  const id = nonEmptyString(input.id);
  const fileName = nonEmptyString(input.fileName);
  const destPath = nonEmptyString(input.destPath);
  const incompletePath = nonEmptyString(input.incompletePath);
  const createdAt = nonEmptyString(input.createdAt);
  const updatedAt = nonEmptyString(input.updatedAt);
  if (
    !id ||
    !fileName ||
    !destPath ||
    !incompletePath ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  return { id, fileName, destPath, incompletePath, createdAt, updatedAt };
}

function normalizedJobSources(
  input: Record<string, unknown>,
): DownloadSource[] {
  const sources = Array.isArray(input.sources)
    ? input.sources
        .map((source, index) => normalizeSource(source, index + 1))
        .filter((source): source is DownloadSource => !!source)
    : [];
  return sources;
}

function applyOptionalJobFields(
  job: DownloadJob,
  input: Record<string, unknown>,
): void {
  const sha1Urn = nonEmptyString(input.sha1Urn);
  const completedAt = nonEmptyString(input.completedAt);
  const error = nonEmptyString(input.error);
  const activeSourceId = nonEmptyString(input.activeSourceId);
  if (sha1Urn) job.sha1Urn = sha1Urn;
  if (completedAt) job.completedAt = completedAt;
  if (error) job.error = error;
  if (activeSourceId) job.activeSourceId = activeSourceId;
}

function normalizeJob(raw: unknown): DownloadJob | undefined {
  const input = asRecord(raw);
  if (!input) return undefined;
  const required = requiredJobFields(input);
  const sources = normalizedJobSources(input);
  if (!required || !sources.length) return undefined;
  const job: DownloadJob = {
    id: required.id,
    status: normalizeStatus(input.status),
    fileName: required.fileName,
    fileSize: nonNegativeNumber(input.fileSize),
    urns: stringArray(input.urns),
    destPath: required.destPath,
    incompletePath: required.incompletePath,
    bytesCompleted: nonNegativeNumber(input.bytesCompleted),
    createdAt: required.createdAt,
    updatedAt: required.updatedAt,
    sources,
  };
  applyOptionalJobFields(job, input);
  return job;
}

function normalizeDoc(value: unknown): DownloadStoreDoc {
  const input = asRecord(value);
  if (!input) return { version: 1, nextId: 1, jobs: [] };
  const jobs = Array.isArray(input.jobs)
    ? input.jobs
        .map((job) => normalizeJob(job))
        .filter((job): job is DownloadJob => !!job)
    : [];
  const maxJobId = jobs.reduce((max, job) => {
    const match = /^d(\d+)$/.exec(job.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return {
    version: DOWNLOAD_STORE_VERSION,
    nextId: Math.max(nonNegativeNumber(input.nextId), maxJobId + 1, 1),
    jobs,
  };
}

/** Load normalized jobs or return an empty store. */
export async function readDownloadStore(
  filePath: string,
  options: { strict?: boolean } = {},
): Promise<DownloadStoreDoc> {
  if (!(await fileExists(filePath)))
    return { version: 1, nextId: 1, jobs: [] };
  const raw = await fsp.readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const doc = normalizeDoc(parsed);
  if (options.strict) {
    const input = asRecord(parsed);
    if (input?.version !== 1 || !Array.isArray(input.jobs))
      throw new Error("Invalid download store");
    if (doc.jobs.length !== input.jobs.length)
      throw new Error("Invalid download jobs");
  }
  return doc;
}

/** Save normalized download jobs by atomic replacement. */
export async function writeDownloadStore(
  filePath: string,
  doc: DownloadStoreDoc,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  const clean = normalizeDoc(doc);
  await fsp.writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, filePath);
}
