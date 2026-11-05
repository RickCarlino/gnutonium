import { expect, test } from "bun:test";
import { APP_VERSION } from "../../src/const";
import { sleep } from "../../src/shared";
import { cliConfig, cliServer } from "../helpers/cli_process";
import { withTempDir } from "../helpers/protocol";

const UPDATE_MESSAGE =
  "A new version of Gnutonium is available: https://github.com/gnutonium/Gnutonium/releases/latest";
const [major, minor] = APP_VERSION.split(".").map(Number);
const NEXT_MINOR = `${major}.${minor + 1}.0`;

function invocation(config: string): string[] {
  return [
    process.execPath,
    "run",
    "tests/helpers/cli_startup_process.ts",
    "run",
    "--config",
    config,
  ];
}

test("--exec startup announces a newer minor release once and stays quiet for patch updates and failures", async () => {
  const server = await cliServer();
  try {
    await withTempDir(async (dir) => {
      const { configPath } = await cliConfig(dir, server.port);
      for (const tag of [
        NEXT_MINOR,
        `${major}.${minor}.999`,
        "offline",
        "pending",
      ]) {
        const child = Bun.spawn(
          [
            ...invocation(configPath),
            "--exec",
            "status",
            "--exec",
            "quit",
          ],
          {
            env: { ...process.env, GNUTONIUM_TEST_RELEASE: tag },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const timeout = setTimeout(() => child.kill(), 1500);
        try {
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(code).toBe(0);
          expect(stderr).toBe("");
          expect(stdout).toContain("peers=0");
          expect(stdout.split(UPDATE_MESSAGE).length - 1).toBe(
            tag === NEXT_MINOR ? 1 : 0,
          );
        } finally {
          clearTimeout(timeout);
          child.kill();
          await child.exited;
        }
      }
    });
  } finally {
    await server.close();
  }
}, 10000);

const ptyTest = process.platform === "win32" ? test.skip : test;
ptyTest(
  "interactive update notice preserves the command being typed",
  async () => {
    const server = await cliServer();
    try {
      await withTempDir(async (dir) => {
        const { configPath } = await cliConfig(dir, server.port);
        let output = "";
        const child = Bun.spawn(invocation(configPath), {
          env: { ...process.env, GNUTONIUM_TEST_RELEASE: NEXT_MINOR },
          terminal: {
            cols: 160,
            rows: 40,
            data: (_terminal, data) => {
              output += Buffer.from(data).toString();
            },
          },
        });
        const terminal = child.terminal;
        if (!terminal) throw new Error("PTY unavailable");
        const waitFor = async (text: string) => {
          const deadline = Date.now() + 3000;
          while (!output.includes(text)) {
            if (Date.now() > deadline)
              throw new Error(`PTY timeout: ${output}`);
            await sleep(5);
          }
        };
        const timeout = setTimeout(() => child.kill(), 4000);
        try {
          await waitFor("] ");
          terminal.write("stat");
          await waitFor(UPDATE_MESSAGE);
          terminal.write("us\r");
          await waitFor("peers=0");
          expect(output.split(UPDATE_MESSAGE)).toHaveLength(2);
          expect(output).not.toContain("command failed:");
          terminal.write("quit\r");
          expect(await child.exited).toBe(0);
        } finally {
          clearTimeout(timeout);
          child.kill();
          await child.exited;
          terminal.close();
        }
      });
    } finally {
      await server.close();
    }
  },
);
