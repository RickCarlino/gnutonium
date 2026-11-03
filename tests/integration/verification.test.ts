import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { withTempDir } from "../helpers/protocol";

const supervisor = path.resolve(
  __dirname,
  "../../scripts/run-with-timeout.ts",
);
const fixture = path.resolve(
  __dirname,
  "../fixtures/verification_tree.ts",
);
const unixTest = process.platform === "win32" ? test.skip : test;
type Tree = { parent: number; child: number };
const settings = {
  waiting: { seconds: "1", code: 124 },
  stubborn: { seconds: "1", code: 124 },
  failure: { seconds: "30", code: 7 },
  "detached-failure": { seconds: "30", code: 7 },
  interrupt: { seconds: "30", code: 143 },
};

async function waitUntil(
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("Process cleanup test timed out");
    await Bun.sleep(10);
  }
}

function running(pid: number): boolean {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  // Orphans may remain zombies briefly until the environment's init reaps them.
  return state !== "" && !state.startsWith("Z");
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

unixTest.each([
  ["waiting", "waiting", false],
  ["stubborn", "stubborn", false],
  ["failure", "failure", false],
  ["detached failure", "detached-failure", false],
  ["nested detached failure", "detached-failure", true],
  ["interrupt", "interrupt", false],
  ["nested timeout", "stubborn", true],
  ["nested interruption", "interrupt", true],
] as const)(
  "verification supervisor cleans the process tree after %s",
  async (_name, mode, nested) => {
    await withTempDir(async (dir) => {
      const marker = path.join(dir, "pids.json");
      const command = [process.execPath, fixture, mode, marker];
      if (nested) command.unshift(process.execPath, supervisor, "30");
      const child = Bun.spawn(
        [process.execPath, supervisor, settings[mode].seconds, ...command],
        { stdout: "pipe", stderr: "pipe" },
      );
      let tree: Tree | undefined;
      try {
        await waitUntil(() => Bun.file(marker).exists());
        tree = (await Bun.file(marker).json()) as Tree;
        if (mode === "interrupt") child.kill("SIGTERM");
        let code: number | undefined;
        void child.exited.then((value) => {
          code = value;
        });
        await waitUntil(async () => code !== undefined);
        expect(code).toBe(settings[mode].code);
        await waitUntil(
          async () => !running(tree!.parent) && !running(tree!.child),
        );
        const stderr = await new Response(child.stderr).text();
        if (settings[mode].code === 124)
          expect(stderr).toContain("timed out after 1s");
      } finally {
        // Test assertions must not themselves leave a supervisor or fixture alive.
        if (!tree && (await Bun.file(marker).exists()))
          tree = (await Bun.file(marker).json()) as Tree;
        if (tree) {
          killGroup(tree.parent);
          killGroup(tree.child);
        }
        child.kill("SIGKILL");
        await child.exited;
      }
    });
  },
  10000,
);

unixTest(
  "verification supervisor preserves success and command failures and rejects invalid deadlines",
  async () => {
    for (const [duration, command, args, expected] of [
      ["5", process.execPath, ["-e", "process.exit(0)"], 0],
      ["5", process.execPath, ["-e", "process.exit(9)"], 9],
      [
        "5",
        process.execPath,
        ["-e", 'process.kill(process.pid, "SIGTERM")'],
        143,
      ],
      [
        "5",
        process.execPath,
        ["-e", 'process.kill(process.pid, "SIGKILL")'],
        137,
      ],
      ["0", process.execPath, [], 2],
      ["NaN", process.execPath, [], 2],
      ["5", "/nonexistent/gnutonium-test-command", [], 127],
    ] as const) {
      const child = Bun.spawn(
        [process.execPath, supervisor, duration, command, ...args],
        { stdout: "pipe", stderr: "pipe" },
      );
      try {
        expect(await child.exited).toBe(expected);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  },
);
