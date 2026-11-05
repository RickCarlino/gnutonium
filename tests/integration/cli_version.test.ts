import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import packageInfo from "../../package.json";
import { cliInvocation } from "../helpers/cli_process";
import { withTempDir } from "../helpers/protocol";

test("version flags print the package version without reading configuration or running commands", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "invalid.json");
    await fs.writeFile(configPath, "invalid json");
    for (const flag of ["-v", "--version"]) {
      const invocation = cliInvocation(configPath);
      for (const args of [
        [...cliInvocation(), flag],
        [...invocation, flag, "--exec", "query never-executed"],
      ]) {
        const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
        const timeout = setTimeout(() => child.kill(), 3000);
        try {
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(code).toBe(0);
          expect(stdout).toBe(`${packageInfo.version}\n`);
          expect(stderr).toBe("");
          expect(await fs.readdir(dir)).toEqual(["invalid.json"]);
        } finally {
          clearTimeout(timeout);
          child.kill();
          await child.exited;
        }
      }
    }
  });
});
