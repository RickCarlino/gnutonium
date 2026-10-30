import { expect, test } from "bun:test";
import { withTempDir } from "../helpers/protocol";

for (const scenario of [
  "malformed-first",
  "malformed-later",
  "incomplete-first",
  "incomplete-later",
  "incomplete-pipelined",
  "oversized-first",
  "oversized-later",
]) {
  test(`incoming HTTP survives ${scenario} request`, async () => {
    await withTempDir(async (dir) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "tests/helpers/http_session_child.ts",
          dir,
          scenario,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      // This deadline lives outside the potentially starved event loop.
      const timer = setTimeout(() => child.kill("SIGKILL"), 4_000);
      try {
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
        child.kill();
        await child.exited;
      }
    });
  }, 6_000);
}
