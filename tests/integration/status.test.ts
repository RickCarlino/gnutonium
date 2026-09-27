import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { sleep } from "../../src/shared";
import { cliInvocation } from "../helpers/cli_process";
import { withTempDir } from "../helpers/protocol";
import { statusJob } from "../helpers/status";

const ptyTest = process.platform === "win32" ? test.skip : test;

function invocation(config: string): string[] {
  return [
    ...cliInvocation(config).slice(0, -3),
    "status",
    `--config=${config}`,
  ];
}

async function until(
  predicate: () => boolean,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`status timeout: ${output()}`);
    await sleep(20);
  }
}

ptyTest(
  "status TUI refreshes partial-file progress, scrolls, resizes, recovers, and restores the terminal",
  async () => {
    await withTempDir(async (dir) => {
      const config = path.join(dir, "config.json");
      const configText = JSON.stringify({ config: { data_dir: "." } });
      await fs.writeFile(config, configText);
      const jobs = Array.from({ length: 30 }, (_, i) =>
        statusJob(dir, {
          id: `d${i + 1}`,
          status: i ? "complete" : "active",
          fileName: `file-${i + 1}.flac`,
          incompletePath: path.join(dir, `incomplete/d${i + 1}.part`),
        }),
      );
      await fs.mkdir(path.join(dir, "incomplete"));
      await fs.writeFile(jobs[0].incompletePath, Buffer.alloc(1024));
      const storePath = path.join(dir, "downloads.json");
      const save = () =>
        fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }));
      await save();
      let output = "";
      const child = Bun.spawn(invocation(config), {
        terminal: {
          cols: 120,
          rows: 24,
          data: (_terminal, bytes) => {
            output += Buffer.from(bytes).toString();
          },
        },
      });
      const terminal = child.terminal!;
      try {
        await until(
          () => output.includes("25%"),
          () => output,
        );
        expect(output).toContain("\x1b[?1049h");
        output = "";
        await fs.appendFile(jobs[0].incompletePath, Buffer.alloc(1024));
        await until(
          () => output.includes("50%"),
          () => output,
        );
        expect(output).toMatch(/\d+(?:\.\d+)? (?:k)?b\/s/);
        output = "";
        terminal.write("\x1b[F");
        await until(
          () => output.includes("file-30.flac"),
          () => output,
        );
        terminal.resize(80, 18);
        output = "";
        terminal.write("\x1b[H");
        await until(
          () => output.includes("file-1.flac"),
          () => output,
        );
        output = "";
        await fs.writeFile(storePath, "{");
        await until(
          () => output.includes("Downloads unavailable"),
          () => output,
        );
        output = "";
        jobs[0].status = "paused";
        await save();
        await until(
          () => output.includes("Paused"),
          () => output,
        );
        terminal.write("q");
        await until(
          () => child.exitCode !== null,
          () => output,
        );
        expect(await child.exited).toBe(0);
        expect(output).toContain("\x1b[?25h\x1b[?1049l");
        expect(await fs.readFile(config, "utf8")).toBe(configText);
        expect(await fs.exists(path.join(dir, "downloads"))).toBe(false);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
        terminal.close();
      }
    });
  },
  15000,
);

ptyTest("Ctrl-C exits the status view cleanly", async () => {
  await withTempDir(async (dir) => {
    const config = path.join(dir, "config.json");
    await fs.writeFile(config, "{}");
    let output = "";
    const child = Bun.spawn(invocation(config), {
      terminal: {
        cols: 80,
        rows: 24,
        data: (_terminal, bytes) => {
          output += Buffer.from(bytes).toString();
        },
      },
    });
    try {
      await until(
        () => output.includes("GNUTONIUM"),
        () => output,
      );
      child.terminal!.write("\x03");
      await until(
        () => child.exitCode !== null,
        () => output,
      );
      expect(await child.exited).toBe(0);
      expect(output).toContain("\x1b[?1049l");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      child.terminal!.close();
    }
  });
});

test("status rejects --exec without running commands or creating configuration", async () => {
  await withTempDir(async (dir) => {
    const config = path.join(dir, "missing.json");
    const child = Bun.spawn([...invocation(config), "--exec", "quit"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain(
      "status does not accept --exec",
    );
    expect(await fs.exists(config)).toBe(false);
  });
});
