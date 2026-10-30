import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  defaultDoc,
  runtimeConfigFor,
} from "../../../src/config/document";
import type { DownloadTransfers } from "../../../src/downloads/dependencies";
import { DownloadManager } from "../../../src/downloads/manager";
import { DownloadTimeoutError } from "../../../src/transfers/errors";
import type { TransferOptions } from "../../../src/transfers/types";
import type {
  GnutellaEventListener,
  RuntimeConfig,
  SearchHit,
} from "../../../src/types";
import { sha1ToUrn } from "../../../src/wire/content_urn";
import { withTempDir } from "../../helpers/protocol";

function hit(patch: Partial<SearchHit> = {}): SearchHit {
  return {
    resultNo: 1,
    queryIdHex: "aa".repeat(16),
    queryHops: 1,
    remoteHost: "9.8.7.6",
    remotePort: 6346,
    speedKBps: 256,
    fileIndex: 5,
    fileName: "alpha.txt",
    fileSize: 5,
    serventIdHex: "11".repeat(16),
    viaPeerKey: "p1",
    ...patch,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function sha1UrnFor(content: Buffer): string {
  return sha1ToUrn(crypto.createHash("sha1").update(content).digest());
}

function makeManager(
  configPath: string,
  options: {
    runtimeConfig?: Partial<RuntimeConfig>;
    collaborators?: { clock: { now: () => number } };
  } = {},
) {
  const doc = defaultDoc(configPath);
  doc.config.dataDir = path.dirname(configPath);
  const config = {
    ...runtimeConfigFor(configPath, doc),
    ...options.runtimeConfig,
  };
  const listeners: GnutellaEventListener[] = [];
  const transfers: DownloadTransfers = {
    direct: async () => {
      throw new Error("unexpected direct transfer");
    },
    push: async () => {
      throw new Error("unexpected push transfer");
    },
  };
  const manager = new DownloadManager({
    config: () => config,
    now: options.collaborators?.clock.now ?? Date.now,
    schedule: (delay, callback) => setTimeout(callback, delay),
    cancel: clearTimeout,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    onError: (error) => {
      throw error;
    },
    transfers,
  });
  return {
    manager,
    transfers,
    results: [] as SearchHit[],
    subscribe: (listener: GnutellaEventListener) =>
      listeners.push(listener),
  };
}

describe("download manager", () => {
  test("does not replace a dangling symlink at download completion", async () => {
    await withTempDir(async (dir) => {
      const node = makeManager(path.join(dir, "config.json"), {
        runtimeConfig: { downloadRetryLimit: 1 },
      });
      const job = await node.manager.queue(hit());
      const outside = path.join(dir, "outside.txt");
      await fs.mkdir(path.dirname(job.destPath), { recursive: true });
      await fs.symlink(outside, job.destPath);
      node.transfers.direct = async (_hit, destPath) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, "hello");
      };
      try {
        await node.manager.start();
        await waitFor(
          () => !!node.manager.getJobs()[0]?.sources[0]?.lastError,
        );
        expect(node.manager.getJobs()[0]?.sources[0]?.lastError).toContain(
          "EEXIST",
        );
        expect((await fs.lstat(job.destPath)).isSymbolicLink()).toBe(true);
        expect(await fs.exists(outside)).toBe(false);
        expect(await fs.readFile(job.incompletePath, "utf8")).toBe(
          "hello",
        );
      } finally {
        await node.manager.stop();
      }
    });
  });

  test("persists consecutive no-progress failures, resets on new bytes, and keeps total attempts", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const initial = makeManager(configPath);
      initial.results = [hit()];
      const job = await initial.manager.queue(initial.results[0]!);
      const expectedFailures = [1, 0, 1, 2];
      for (let step = 0; step < expectedFailures.length; step++) {
        const node = makeManager(configPath, {
          runtimeConfig: { downloadRetryLimit: 2 },
          collaborators: { clock: { now: () => 1_000_000 * (step + 1) } },
        });
        node.transfers.direct = async (_hit, destPath, options) => {
          if (step === 1) await fs.writeFile(destPath, "he");
          // Progress notifications alone must not count as saved data.
          options?.onProgress?.({ bytesCompleted: 4 });
          throw new DownloadTimeoutError("body", "download body stalled");
        };
        try {
          await node.manager.start();
          await waitFor(
            () => node.manager.getJobs()[0]?.status !== "active",
          );
          const failed = node.manager.getJobs()[0]!;
          expect(failed.status).toBe(step === 3 ? "failed" : "queued");
          expect(failed.sources[0]?.attempts).toBe(step + 1);
          expect(failed.sources[0]?.failuresWithoutProgress).toBe(
            expectedFailures[step],
          );
        } finally {
          await node.manager.stop();
        }
      }
      const restarted = makeManager(configPath);
      await restarted.manager.persist();
      expect(
        restarted.manager.getJobs()[0]?.sources[0]
          ?.failuresWithoutProgress,
      ).toBe(2);
      const resumed = await restarted.manager.resume(job.id);
      expect(resumed.sources[0]?.failuresWithoutProgress).toBe(0);
      expect(resumed.sources[0]?.attempts).toBe(4);
      expect(await fs.readFile(job.incompletePath, "utf8")).toBe("he");
    });
  });

  test("persists queued jobs across manager instances", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const first = makeManager(configPath);
      first.results = [hit()];

      const queued = await first.manager.queue(first.results[0]!);
      await first.manager.persist();

      const second = makeManager(configPath);
      await second.manager.persist();

      expect(second.manager.getJobs()).toEqual([
        expect.objectContaining({
          id: queued.id,
          status: "queued",
          fileName: "alpha.txt",
        }),
      ]);
    });
  });

  test("verifies SHA1 downloads before moving them complete", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const content = Buffer.from("hello");
      const sha1Urn = sha1UrnFor(content);
      const events: string[] = [];
      const node = makeManager(configPath);
      node.subscribe((event) => events.push(event.type));
      node.results = [hit({ sha1Urn, urns: [sha1Urn] })];
      node.transfers.direct = async (
        _hit: SearchHit,
        destPath: string,
        options?: TransferOptions,
      ) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, content);
        options?.onProgress?.({ bytesCompleted: content.length });
      };

      const job = await node.manager.queue(node.results[0]!);
      await node.manager.start();
      await waitFor(
        () => node.manager.getJobs()[0]?.status === "complete",
      );

      const completed = node.manager.getJobs()[0];
      expect(completed).toMatchObject({
        id: job.id,
        status: "complete",
        bytesCompleted: content.length,
      });
      expect(await fs.readFile(completed!.destPath, "utf8")).toBe("hello");
      await expect(fs.stat(completed!.incompletePath)).rejects.toThrow();
      expect(node.manager.getHistory()).toHaveLength(1);
      expect(events).toContain("DOWNLOAD_SUCCEEDED");
    });
  });

  test("marks mismatched SHA1 downloads as verification_failed", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const sha1Urn = sha1UrnFor(Buffer.from("expected"));
      const node = makeManager(configPath);
      node.results = [hit({ sha1Urn, urns: [sha1Urn] })];
      node.transfers.direct = async (
        _hit: SearchHit,
        destPath: string,
        options?: TransferOptions,
      ) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, "wrong");
        options?.onProgress?.({ bytesCompleted: 5 });
      };

      await node.manager.queue(node.results[0]!);
      await node.manager.start();
      await waitFor(
        () => node.manager.getJobs()[0]?.status === "verification_failed",
      );

      const failed = node.manager.getJobs()[0];
      expect(failed?.error).toBe("SHA1 verification failed");
      expect(await fs.readFile(failed!.incompletePath, "utf8")).toBe(
        "wrong",
      );
      expect(node.manager.getHistory()).toHaveLength(0);
    });
  });

  test("fails a completed transfer when the final size is wrong", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const node = makeManager(configPath);
      node.results = [hit({ fileSize: 10 })];
      node.transfers.direct = async (
        _hit: SearchHit,
        destPath: string,
        options?: TransferOptions,
      ) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, "short");
        options?.onProgress?.({ bytesCompleted: 5 });
      };

      const job = await node.manager.queue(node.results[0]!);
      await node.manager.start();
      await waitFor(() => node.manager.getJobs()[0]?.status === "failed");

      const failed = node.manager.getJobs()[0];
      expect(failed).toMatchObject({
        id: job.id,
        status: "failed",
        bytesCompleted: 0,
        error: "download size mismatch: expected 10 bytes, got 5",
      });
      expect(failed?.sources[0]?.lastError).toBe(
        "download size mismatch: expected 10 bytes, got 5",
      );
      await expect(fs.stat(job.incompletePath)).rejects.toThrow();
      expect(node.manager.getHistory()).toHaveLength(0);
    });
  });

  test("pauses, resumes, and removes queued jobs", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const node = makeManager(configPath);
      node.results = [hit()];

      const job = await node.manager.queue(node.results[0]!);
      await fs.mkdir(path.dirname(job.incompletePath), {
        recursive: true,
      });
      await fs.writeFile(job.incompletePath, "part");

      expect((await node.manager.pause(job.id)).status).toBe("paused");
      expect((await node.manager.resume(job.id)).status).toBe("queued");
      await node.manager.remove(job.id);

      expect(node.manager.getJobs()).toEqual([]);
      await expect(fs.stat(job.incompletePath)).rejects.toThrow();
    });
  });

  test("pausing a direct transfer does not attempt push fallback", async () => {
    await withTempDir(async (dir) => {
      const node = makeManager(path.join(dir, "protocol.json"));
      node.results = [hit()];
      let started = false;
      let pushed = false;
      node.transfers.direct = async (_hit, _path, options) => {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("download aborted")),
            { once: true },
          );
          started = true;
        });
      };
      node.transfers.push = async () => {
        pushed = true;
      };
      const job = await node.manager.queue(node.results[0]!);
      try {
        await node.manager.start();
        await waitFor(() => started);
        await node.manager.pause(job.id);
        expect(node.manager.getJobs()[0]?.status).toBe("paused");
        expect(pushed).toBe(false);
      } finally {
        await node.manager.stop();
      }
    });
  });
});
