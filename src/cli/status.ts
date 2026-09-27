import process from "node:process";
import { errMsg } from "../shared";
import { renderStatus } from "./status_report";
import {
  readStatusState,
  StatusSampler,
  type StatusState,
} from "./status_state";

/** Watch download state in a read-only terminal panel. */
export async function watchStatus(configPath: string): Promise<void> {
  if (!process.stdout.isTTY) throw new Error("status requires a terminal");
  let state = await readStatusState(configPath);
  const sampler = new StatusSampler();
  sampler.sample(state);
  let stopped = false;
  let offset = 0;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  const draw = () => {
    const result = renderStatus(
      state,
      process.stdout.columns || 80,
      process.stdout.rows || 24,
      offset,
    );
    offset = result.offset;
    process.stdout.write(`\x1b[H${result.frame}\x1b[J`);
  };
  const key = (chunk: Buffer) => {
    const input = chunk.toString();
    if (input.includes("\x03") || input === "q") return stop();
    offset += scrollAmount(input, process.stdout.rows || 24);
    if (input === "\x1b[H") offset = 0;
    if (input === "\x1b[F") offset = state.downloads.length;
    draw();
  };
  const raw = process.stdin.isRaw;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.on("resize", draw);
  process.stdin.on("data", key);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  try {
    draw();
    while (!stopped) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
      if (stopped) break;
      state = await refresh(configPath, sampler);
      if (!stopped) draw();
    }
  } finally {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdout.off("resize", draw);
    process.stdin.off("data", key);
    if (process.stdin.isTTY) process.stdin.setRawMode(raw);
    process.stdin.pause();
  }
}

function scrollAmount(key: string, rows: number): number {
  const page = Math.max(1, rows - 10);
  const moves: Record<string, number> = {
    "\x1b[A": -1,
    k: -1,
    "\x1b[B": 1,
    j: 1,
    "\x1b[5~": -page,
    "\x1b[6~": page,
  };
  return moves[key] || 0;
}

async function refresh(
  configPath: string,
  sampler: StatusSampler,
): Promise<StatusState> {
  try {
    return sampler.sample(await readStatusState(configPath));
  } catch (error) {
    return sampler.sample({
      downloads: [],
      downloadError: errMsg(error),
      now: Date.now(),
    });
  }
}
