import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { CommandRunner } from "../../src/cli/runner";
import { createCacheState } from "../../src/discovery/gwebcache/state";
import type { DownloadJob } from "../../src/downloads";
import { executeLine, executionContext } from "../helpers/cli";
import {
  cliConfig,
  cliInvocation,
  cliServer,
} from "../helpers/cli_process";
import { makeNode, withTempDir } from "../helpers/protocol";

test("localhost runner batches real search results and queued jobs without public bootstrap", async () => {
  const server = await cliServer();
  try {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "config.json"), {
        runtimeConfig: {
          gwebCaches: createCacheState([
            `http://127.0.0.1:${server.port}/cache`,
          ]),
        },
      });
      const logs: string[] = [];
      const context = executionContext(node, (line) => logs.push(line));
      const runner = new CommandRunner(context);
      try {
        await runner.submit(`browse 127.0.0.1:${server.port}`);
        await runner.submit(`browse 127.0.0.1:${server.port}`);
        expect(node.getSearches()).toHaveLength(2);
        await runner.submit("results q1-q2,q1");
        expect(logs.at(-1)).toContain("q2:");
        expect(
          (await runner.submit(`download 1-3 "${dir}/one file"`)).failures,
        ).toBe(1);
        expect(node.getDownloadJobs()).toEqual([]);
        const queued = await runner.submit("download 1, 2-3");
        expect(queued).toMatchObject({ successes: 3, failures: 0 });
        expect(queued.createdJobs).toHaveLength(3);
        expect(node.getDownloadJobs().map((j) => j.status)).toEqual([
          "queued",
          "queued",
          "queued",
        ]);
        await runner.submit("pause queued");
        expect(node.getDownloadJobs().map((j) => j.status)).toEqual([
          "paused",
          "paused",
          "paused",
        ]);
        await runner.submit("resume d1-d3");
        await runner.submit("clear q1,q2");
        expect(node.getSearches()).toEqual([]);
        expect(node.getDownloadJobs()).toHaveLength(3);
        await runner.submit("clear downloads queued");
        expect(node.getDownloadJobs()).toEqual([]);
      } finally {
        await node.stop();
      }
    });
  } finally {
    await server.close();
  }
});

test("real --exec uses selectors, destinations, continue-after-error, and preserves completed files", async () => {
  const server = await cliServer();
  try {
    await withTempDir(async (dir) => {
      const { configPath } = await cliConfig(dir, server.port);
      const completed = path.join(dir, "completed.txt");
      await fs.writeFile(completed, "keep me");
      const done: DownloadJob = {
        id: "d1",
        status: "complete",
        fileName: "completed.txt",
        fileSize: 7,
        urns: [],
        destPath: completed,
        incompletePath: path.join(dir, "old.part"),
        bytesCompleted: 7,
        createdAt: new Date().toJSON(),
        updatedAt: new Date().toJSON(),
        sources: [
          {
            id: "s1",
            resultNo: 99,
            queryIdHex: "ab".repeat(16),
            queryHops: 1,
            remoteHost: "127.0.0.1",
            remotePort: server.port,
            speedKBps: 1,
            fileIndex: 99,
            fileName: "completed.txt",
            fileSize: 7,
            serventIdHex: "cd".repeat(16),
            viaPeerKey: "p1",
            attempts: 0,
            failuresWithoutProgress: 0,
          },
        ],
      };
      await fs.writeFile(
        path.join(dir, "downloads.json"),
        JSON.stringify({ version: 1, nextId: 2, jobs: [done] }),
      );
      const destination = path.join(dir, "Music/live recording.flac");
      const commands = [
        `browse 127.0.0.1:${server.port}`,
        `browse 127.0.0.1:${server.port}`,
        "results q1-q2,q1",
        `download 1-3 "${destination}"`,
        "download 1,999",
        `download 1,1 "${destination}"`,
        "download 2-3",
        "pause active,queued",
        "downloads paused",
        "resume paused",
        "pause d2-d4",
        "info d2",
        "clear q1-q2",
        "downloads",
        "clear d2-d4",
        "clear complete",
        "downloads",
        "bogus",
        "status",
        "quit",
        "query after-quit",
      ];
      const child = Bun.spawn(
        [
          ...cliInvocation(configPath),
          ...commands.flatMap((command) => ["--exec", command]),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(
        "a destination requires exactly one unique result",
      );
      expect(stdout).toContain("no such result 999");
      expect(stdout).toContain("download: d2");
      expect(stdout).toContain(JSON.stringify(destination));
      expect(stdout).toContain("pause: 3 succeeded, 0 no-op, 0 failed");
      expect(stdout).toContain("clear: 2 succeeded, 0 no-op, 0 failed");
      expect(stdout).toContain("download d1 removed");
      expect(stdout).toContain("command failed: unknown command: bogus");
      expect(stdout).not.toContain("exec> query after-quit");
      expect(await fs.readFile(completed, "utf8")).toBe("keep me");
      const persisted = JSON.parse(
        await fs.readFile(path.join(dir, "downloads.json"), "utf8"),
      );
      expect(persisted.jobs).toEqual([]);
    });
  } finally {
    await server.close();
  }
}, 15000);

test("real filesystem batch failure reports the target and continues", async () => {
  const server = await cliServer();
  try {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "config.json"));
      const logs: string[] = [];
      const context = executionContext(node, (line) => logs.push(line));
      try {
        await executeLine(context, `browse 127.0.0.1:${server.port}`);
        await executeLine(context, "download 1-3");
        const jobs = node.getDownloadJobs();
        await fs.mkdir(jobs[0].incompletePath, { recursive: true });
        await fs.writeFile(jobs[1].incompletePath, "partial");
        const result = await executeLine(context, "remove d1-d3");
        expect(result).toMatchObject({ successes: 2, failures: 1 });
        expect(result.targets[0].target).toBe("d1");
        expect(logs.join("\n")).toContain("d1 failed:");
        expect(await fs.exists(jobs[1].incompletePath)).toBe(false);
        expect(node.getDownloadJobs()).toEqual([]);
      } finally {
        await node.stop();
      }
    });
  } finally {
    await server.close();
  }
});
