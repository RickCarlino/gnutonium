import { formatSize } from "../cli_shared";
import type { DownloadStatus } from "../downloads/types";
import type { StatusDownload, StatusState } from "./status_state";

const STATUS_LABEL: Record<DownloadStatus, string> = {
  active: "Active",
  queued: "Queued",
  paused: "Paused",
  verifying: "Verifying",
  complete: "Complete",
  failed: "Failed",
  verification_failed: "Bad hash",
};
const ORDER: DownloadStatus[] = [
  "active",
  "verifying",
  "failed",
  "verification_failed",
  "queued",
  "paused",
  "complete",
];
const SEGMENTS = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function clean(value: string): string {
  return value.replace(
    /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    " ",
  );
}

function fit(value: string, width: number): string {
  const safe = clean(value);
  if (Bun.stringWidth(safe) <= width)
    return safe.padEnd(safe.length + width - Bun.stringWidth(safe));
  let out = "";
  for (const { segment } of SEGMENTS.segment(safe)) {
    if (Bun.stringWidth(out + segment) > width - 1) break;
    out += segment;
  }
  return `${out}…`.padEnd(out.length + width - Bun.stringWidth(out));
}

function eta(row: StatusDownload): string {
  if (!row.rate || !row.job.fileSize) return "—";
  const seconds = Math.ceil((row.job.fileSize - row.bytes) / row.rate);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function done(row: StatusDownload): string {
  return row.job.fileSize
    ? `${Math.floor((row.bytes / row.job.fileSize) * 100)}%`
    : "—";
}

function tableRow(row: StatusDownload, width: number): string {
  const file = row.job.error
    ? `${row.job.fileName} — ${row.job.error}`
    : row.job.fileName;
  const cells = [
    fit(row.job.id, 6),
    fit(STATUS_LABEL[row.job.status], 9),
    fit(done(row), 4),
  ];
  if (width >= 100) cells.push(fit(formatSize(row.job.fileSize), 9));
  if (width >= 75)
    cells.push(
      fit(row.rate === undefined ? "—" : `${formatSize(row.rate)}/s`, 11),
    );
  if (width >= 100) cells.push(fit(eta(row), 5));
  return `${cells.join(" ")}  ${file}`;
}

function tableHeader(width: number): string {
  const cells = [fit("ID", 6), fit("STATUS", 9), fit("DONE", 4)];
  if (width >= 100) cells.push(fit("SIZE", 9));
  if (width >= 75) cells.push(fit("RATE", 11));
  if (width >= 100) cells.push(fit("ETA", 5));
  return `${cells.join(" ")}  FILE`;
}

function summary(state: StatusState): string[] {
  const jobs = state.downloads;
  const count = (status: DownloadStatus) =>
    jobs.filter((r) => r.job.status === status).length;
  const unfinished = jobs.filter((r) => r.job.status !== "complete");
  const completed = jobs.filter((r) => r.job.status === "complete");
  const rate = jobs.reduce((sum, r) => sum + (r.rate || 0), 0);
  const left = unfinished.reduce(
    (sum, r) => sum + Math.max(0, r.job.fileSize - r.bytes),
    0,
  );
  const completeBytes = completed.reduce((sum, r) => sum + r.bytes, 0);
  return [
    `${count("active")} active  ·  ${count("queued")} queued  ·  ${count("paused")} paused  ·  ${count("verifying")} verifying`,
    `${count("complete")} complete  ·  ${count("failed") + count("verification_failed")} failed  ·  ${formatSize(rate)}/s`,
    `${formatSize(left)} remaining  ·  ${formatSize(completeBytes)} completed`,
  ];
}

/** Render a bounded terminal panel with all jobs accessible by scrolling. */
export function renderStatus(
  state: StatusState,
  columns: number,
  rows: number,
  offset = 0,
): { frame: string; offset: number } {
  const width = Math.max(1, columns - 1);
  const height = Math.max(1, rows - 1);
  const jobs = [...state.downloads].sort(
    (a, b) =>
      ORDER.indexOf(a.job.status) - ORDER.indexOf(b.job.status) ||
      a.job.id.localeCompare(b.job.id, undefined, { numeric: true }),
  );
  const body = state.downloadError
    ? [`Downloads unavailable: ${state.downloadError}`]
    : summary(state);
  const library = state.library
    ? `Library  ${state.library.count} files · ${formatSize(state.library.bytes)}`
    : "Library  —";
  const header = [
    `GNUTONIUM   ${new Date(state.now).toLocaleTimeString()}`,
    "─".repeat(width),
    ...body,
    state.libraryError ? "Library  unavailable" : library,
    "─".repeat(width),
    tableHeader(width),
  ];
  const capacity = Math.max(0, height - header.length - 1);
  const start = Math.min(
    Math.max(0, offset),
    Math.max(0, jobs.length - capacity),
  );
  const visible = jobs.slice(start, start + capacity);
  const lines = visible.map((row) => tableRow(row, width));
  if (!jobs.length && !state.downloadError && capacity)
    lines.push("No downloads");
  const footer = jobs.length
    ? `${start + 1}–${start + visible.length} / ${jobs.length}`
    : "";
  const frame = [
    ...header,
    ...lines,
    ...Array(Math.max(0, capacity - lines.length)).fill(""),
    footer,
  ]
    .slice(0, height)
    .map((line) => fit(line, width))
    .join("\r\n");
  return { frame, offset: start };
}
