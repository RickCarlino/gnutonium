import { spawn } from "node:child_process";

// A real grandchild that ignores TERM exercises the supervisor's KILL path,
// including when its parent has already exited.
async function main(): Promise<void> {
  const [mode, marker, parent] = process.argv.slice(2);
  if (mode === "grandchild") {
    process.on("SIGTERM", () => {});
    await Bun.write(
      marker!,
      JSON.stringify({ parent: Number(parent), child: process.pid }),
    );
  } else {
    if (mode === "stubborn") process.on("SIGTERM", () => {});
    spawn(
      process.execPath,
      [__filename, "grandchild", marker!, String(process.pid)],
      { detached: mode === "detached-failure", stdio: "ignore" },
    );
    if (mode === "detached-failure") process.exit(7);
    if (mode === "failure") {
      while (!(await Bun.file(marker!).exists())) await Bun.sleep(5);
      process.exit(7);
    }
  }
  setInterval(() => {}, 1000);
}

void main();
