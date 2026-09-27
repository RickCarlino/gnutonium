import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { renderStatus } from "../../../src/cli/status_report";
import {
  readStatusState,
  StatusSampler,
  type StatusState,
} from "../../../src/cli/status_state";
import { parseCli } from "../../../src/cli_shared";
import { withTempDir } from "../../helpers/protocol";
import { statusJob } from "../../helpers/status";

function state(bytes: number, now: number, patch = {}): StatusState {
  return {
    now,
    downloads: [{ job: statusJob("/tmp", patch), bytes, measured: true }],
  };
}

test("status accepts both config syntaxes", () => {
  for (const args of [
    ["--config=some file.json"],
    ["--config", "some file.json"],
  ])
    expect(parseCli(["status", ...args], "default.json")).toEqual({
      command: "status",
      config: "some file.json",
      exec: [],
    });
});

test("status reads config-relative data and growing partial files without creating or rewriting state", async () => {
  await withTempDir(async (dir) => {
    const config = path.join(dir, "config.json");
    const data = path.join(dir, "state");
    await fs.mkdir(path.join(data, "incomplete"), { recursive: true });
    const configText = JSON.stringify({
      config: {
        data_dir: "state",
        gwebcache_urls: ["http://127.0.0.1/cache"],
      },
    });
    await fs.writeFile(config, configText);
    const job = statusJob(data);
    const store = JSON.stringify({ version: 1, jobs: [job] });
    await fs.writeFile(path.join(data, "downloads.json"), store);
    await fs.writeFile(job.incompletePath, Buffer.alloc(2048));
    await fs.writeFile(
      path.join(data, "share-index.json"),
      JSON.stringify({
        version: 1,
        files: [{ rel: "song.flac", size: 123, mtimeMs: 1 }],
      }),
    );
    const snapshot = await readStatusState(config, 1000);
    expect(snapshot.downloads[0].bytes).toBe(2048);
    expect(snapshot.downloads[0].job.status).toBe("active");
    expect(snapshot.library).toEqual({ count: 1, bytes: 123 });
    expect(await fs.readFile(config, "utf8")).toBe(configText);
    expect(
      await fs.readFile(path.join(data, "downloads.json"), "utf8"),
    ).toBe(store);
    expect(await fs.exists(path.join(data, "downloads"))).toBe(false);
  });
});

test("missing state is empty; invalid state is unavailable and recovers on the next read", async () => {
  await withTempDir(async (dir) => {
    const config = path.join(dir, "config.json");
    await expect(readStatusState(config)).rejects.toThrow();
    expect(await fs.exists(config)).toBe(false);
    await fs.writeFile(config, '{"config":{"data_dir":"data"}}');
    expect((await readStatusState(config)).downloads).toEqual([]);
    expect(await fs.exists(path.join(dir, "data"))).toBe(false);
    await fs.mkdir(path.join(dir, "data"));
    const file = path.join(dir, "data/downloads.json");
    for (const invalid of [
      "{",
      '{"version":9,"jobs":[]}',
      '{"version":1,"jobs":[{}]}',
    ]) {
      await fs.writeFile(file, invalid);
      expect((await readStatusState(config)).downloadError).toBeTruthy();
    }
    await fs.writeFile(file, '{"version":1,"jobs":[]}');
    expect((await readStatusState(config)).downloadError).toBeUndefined();
  });
});

test("rates use measured progress and handle resume, truncation, errors and removed jobs", () => {
  const sampler = new StatusSampler();
  expect(
    sampler.sample(state(1024, 1000)).downloads[0].rate,
  ).toBeUndefined();
  expect(sampler.sample(state(2048, 2000)).downloads[0].rate).toBe(1024);
  expect(sampler.sample(state(2048, 3000)).downloads[0].rate).toBe(0);
  expect(sampler.sample(state(0, 4000)).downloads[0].rate).toBeUndefined();
  sampler.sample(state(1024, 5000, { status: "paused" }));
  expect(
    sampler.sample(state(2048, 6000)).downloads[0].rate,
  ).toBeUndefined();
  sampler.sample({
    now: 7000,
    downloads: [],
    downloadError: "unreadable",
  });
  expect(
    sampler.sample(state(3000, 8000)).downloads[0].rate,
  ).toBeUndefined();
});

test("panel prioritizes active transfers, calculates totals, and scrolls through every job", () => {
  const snapshot = state(2048, 2000);
  snapshot.downloads[0].rate = 1024;
  for (let n = 2; n <= 40; n++)
    snapshot.downloads.push({
      job: statusJob("/tmp", {
        id: `d${n}`,
        status: "complete",
        fileName: `finished-${n}.flac`,
      }),
      bytes: 4096,
      measured: false,
    });
  const top = renderStatus(snapshot, 120, 24);
  expect(top.frame).toContain("50%");
  expect(top.frame).toContain("1.0 kb/s");
  expect(top.frame).toContain("39 complete");
  expect(top.frame).toContain("2.0 kb remaining");
  expect(top.frame).toContain("recording.flac");
  const bottom = renderStatus(snapshot, 120, 24, 999);
  expect(bottom.frame).toContain("finished-40.flac");
  expect(bottom.offset).toBeGreaterThan(0);
});

test("terminal text is bounded, Unicode-aware, and cannot inject terminal controls", () => {
  const snapshot = state(0, 1000, {
    fileName: "\x1b[2Jhello\n世界👩‍💻".repeat(20),
  });
  for (const [columns, rows] of [
    [120, 40],
    [80, 24],
    [40, 12],
    [12, 4],
  ]) {
    const { frame } = renderStatus(snapshot, columns, rows);
    expect(frame).not.toContain("\x1b");
    expect(frame.split("\r\n").length).toBeLessThan(rows);
    for (const line of frame.split("\r\n"))
      expect(Bun.stringWidth(line)).toBeLessThan(columns);
  }
});
