import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";

const KILL_GRACE_MS = 2000;

type ProcessInfo = {
  pid: number;
  parent: number;
  group: number;
  owned: boolean;
};

function processTree(scope: string): ProcessInfo[] {
  const result = spawnSync(
    "ps",
    [
      process.platform === "darwin" ? "-Eww" : "eww",
      "-A",
      "-o",
      "pid=,ppid=,pgid=,command=",
    ],
    {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) return [];
  const marker = new RegExp(`(?:^|\\s)${scope}=1(?:\\s|$)`);
  return result.stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+/.exec(line);
      if (!match) return [];
      return [
        {
          pid: Number(match[1]),
          parent: Number(match[2]),
          group: Number(match[3]),
          owned: marker.test(line),
        },
      ];
    });
}

function trackDescendantGroups(groups: Set<number>, scope: string): void {
  if (!groups.size) return;
  const processes = processTree(scope);
  // Inherited markers survive reparenting, even when a detached child's
  // original parent exits before the first process-tree scan.
  for (const { group, owned } of processes) {
    if (owned) groups.add(group);
  }
  const descendants = new Set<number>();
  let found = true;
  while (found) {
    found = false;
    for (const { pid, parent, group } of processes) {
      if (descendants.has(pid)) continue;
      if (!groups.has(group) && !descendants.has(parent)) continue;
      descendants.add(pid);
      groups.add(group);
      found = true;
    }
  }
}

function signalGroups(
  groups: Set<number>,
  signal: NodeJS.Signals,
): boolean {
  let signaled = false;
  for (const group of groups) {
    try {
      process.kill(-group, signal);
      signaled = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return signaled;
}

/** Run a command with a deadline and clean up its process groups. */
async function main(): Promise<number> {
  const [duration, command, ...args] = process.argv.slice(2);
  const seconds = Number(duration);
  if (
    !command ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 2_147_483
  ) {
    console.error(
      "Usage: run-with-timeout.ts <positive seconds> <command> [args...]",
    );
    return 2;
  }

  return new Promise<number>((resolve) => {
    // Each supervisor adds its own marker while preserving ancestor markers.
    // Nested cleanup can then identify its children without killing its owner.
    const scope = `GNUTONIUM_VERIFY_SCOPE_${randomUUID().replaceAll("-", "")}`;
    const child = spawn(command, args, {
      detached: true,
      stdio: "inherit",
      env: { ...process.env, [scope]: "1" },
    });
    const groups = new Set(child.pid ? [child.pid] : []);
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number) => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      resolve(code);
    };
    const stop = (code: number) => {
      if (stopping) return;
      stopping = true;
      clearTimeout(deadline);
      // Remember detached groups before TERM can orphan them or kill the
      // nested supervisors responsible for their own cleanup.
      trackDescendantGroups(groups, scope);
      // A shell can exit while a grandchild ignores TERM. Keep the grace
      // timer alive independently of the immediate child's exit event.
      if (!signalGroups(groups, "SIGTERM")) return finish(code);
      killTimer = setTimeout(() => {
        trackDescendantGroups(groups, scope);
        signalGroups(groups, "SIGKILL");
        finish(code);
      }, KILL_GRACE_MS);
    };
    const onInterrupt = () => stop(130);
    const onTerminate = () => stop(143);
    const deadline = setTimeout(() => {
      console.error(
        `Verification timed out after ${seconds}s; terminating process group.`,
      );
      stop(124);
    }, seconds * 1000);
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    child.once("error", (error) => {
      console.error(error.message);
      stop(127);
    });
    child.once("exit", (code, signal) =>
      stop(code ?? (signal ? 128 + constants.signals[signal] : 1)),
    );
  });
}

void main().then((code) => {
  process.exitCode = code;
});
