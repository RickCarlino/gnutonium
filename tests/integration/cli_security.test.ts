import { expect, test } from "bun:test";
import { sleep } from "../../src/shared";
import {
  cliConfig,
  cliInvocation,
  cliServer,
} from "../helpers/cli_process";
import { withTempDir } from "../helpers/protocol";

const REMOTE_NAME = "remote-\x1b]52;c;cGF5bG9hZA==\x07-\x9b2J.txt";

function assertSafe(output: string): void {
  expect(output).toContain("remote-");
  expect(output).not.toContain("\x1b]52;");
  expect(output).not.toContain("\x9b2J");
  expect(output).not.toContain("\x07");
}

test("CLI --exec neutralizes terminal escapes in peer search results", async () => {
  const server = await cliServer(REMOTE_NAME);
  try {
    await withTempDir(async (dir) => {
      const { configPath } = await cliConfig(dir, server.port);
      const commands = [
        `browse 127.0.0.1:${server.port}`,
        "results",
        "quit",
      ];
      const child = Bun.spawn(
        [
          ...cliInvocation(configPath),
          ...commands.flatMap((command) => ["--exec", command]),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => child.kill(), 4000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe("");
        assertSafe(stdout);
      } finally {
        clearTimeout(timer);
        child.kill();
        await child.exited;
      }
    });
  } finally {
    await server.close();
  }
});

const ptyTest = process.platform === "win32" ? test.skip : test;
ptyTest("interactive CLI neutralizes peer terminal escapes", async () => {
  const server = await cliServer(REMOTE_NAME);
  try {
    await withTempDir(async (dir) => {
      const { configPath } = await cliConfig(dir, server.port);
      let output = "";
      const child = Bun.spawn(cliInvocation(configPath), {
        terminal: {
          cols: 160,
          rows: 40,
          data: (_terminal, data) => {
            output += Buffer.from(data).toString();
          },
        },
      });
      const terminal = child.terminal!;
      const waitFor = async (text: string) => {
        const deadline = Date.now() + 3000;
        while (!output.includes(text)) {
          if (Date.now() > deadline)
            throw new Error(`PTY timeout: ${output}`);
          await sleep(10);
        }
      };
      try {
        await waitFor("] ");
        terminal.write(`browse 127.0.0.1:${server.port}\nresults\n`);
        await waitFor("remote-");
        assertSafe(output);
        terminal.write("quit\n");
        expect(await child.exited).toBe(0);
      } finally {
        child.kill();
        await child.exited;
        terminal.close();
      }
    });
  } finally {
    await server.close();
  }
});
