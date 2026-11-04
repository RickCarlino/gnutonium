import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { GnutellaServent } from "../../src/protocol";
import { sleep } from "../../src/shared";
import {
  cliConfig,
  cliInvocation,
  cliServer,
} from "../helpers/cli_process";
import { withTempDir } from "../helpers/protocol";

async function until(
  predicate: () => boolean,
  transcript: () => string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`PTY timeout: ${transcript()}`);
    await sleep(10);
  }
}
function terminalClient(config: string) {
  let output = "";
  const child = Bun.spawn(cliInvocation(config), {
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
  return {
    child,
    output: () => output,
    send: async (text: string) => {
      terminal.write(text);
      await sleep(35);
    },
    wait: async (text: string) =>
      until(
        () => output.includes(text),
        () => output,
      ),
    close: async () => {
      child.kill();
      await child.exited;
      terminal.close();
    },
  };
}
const ptyTest = process.platform === "win32" ? test.skip : test;
ptyTest(
  "PTY Tab, list replacement, monitor and throbber redraw preserve input and cursor; Ctrl-C interrupts sleep",
  async () => {
    const cache = await cliServer();
    try {
      await withTempDir(async (dir) => {
        const remoteConfig = await cliConfig(
          path.join(dir, "remote"),
          cache.port,
        );
        await fs.mkdir(path.join(dir, "remote/downloads"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(dir, "remote/downloads/hello.txt"),
          "hello",
        );
        remoteConfig.doc.config.ultrapeer = true;
        const remote = new GnutellaServent(
          remoteConfig.configPath,
          remoteConfig.doc,
        );
        await remote.start();
        const local = await cliConfig(path.join(dir, "local"), cache.port);
        const client = terminalClient(local.configPath);
        try {
          await until(() => /\[0+\//.test(client.output()), client.output);
          await client.send("sta");
          await client.send("\t");
          await client.send("\r");
          await client.wait("peers=0");
          await client.send("do");
          await client.send("\t");
          await client.send("\t");
          await client.wait("downloads");
          await client.send("\x15");
          await client.send("monitor all\r");
          await client.send(
            `connect 127.0.0.1:${remoteConfig.doc.config.listenPort}\r`,
          );
          await client.wait(
            `peer 127.0.0.1:${remoteConfig.doc.config.listenPort} connected`,
          );
          expect(client.output()).toContain("X-Query-Routing=0.2");
          expect(client.output()).toContain("X-Max-TTL=4");
          expect(client.output()).toContain("Accept-Encoding=deflate");
          await client.send(
            `browse 127.0.0.1:${remoteConfig.doc.config.listenPort}\r`,
          );
          await client.wait("q1:");
          await client.send("results q,q1");
          await client.send("\x1b[D".repeat(3));
          remote.sendPing(1);
          await sleep(100);
          await client.send("\t");
          await client.send("\r");
          await client.wait("hello.txt");
          expect(client.output()).not.toContain("command failed:");
          for (const [mode, number] of [
            ["off", 2],
            ["on", 3],
          ] as const) {
            await client.send(`monitor ${mode}\r`);
            await client.send("query BeforeAfter");
            await client.send("\x1b[D".repeat(5));
            remote.sendPing(1);
            await sleep(180);
            await client.send("Middle");
            await client.send("\r");
            await client.wait(`q${number}: "BeforeMiddleAfter"`);
          }
          expect(client.output()).toContain("[rx] PING");
          await client.send("results Q3,q1");
          await client.send("\x1b[D".repeat(3));
          remote.sendPing(1);
          await sleep(100);
          await client.send("\t");
          await client.send("\r");
          expect(client.output()).toContain("results q3,q1");
          expect(client.output()).not.toContain("command failed:");
          await client.send("sleep 0.1\rmonitor off\rmonitor on\r");
          await sleep(180);
          expect(
            client.output().lastIndexOf("monitor on"),
          ).toBeGreaterThan(client.output().lastIndexOf("monitor off"));
          await client.send("sleep 30\r");
          await client.send("\x03");
          await until(() => client.child.exitCode !== null, client.output);
          expect(await client.child.exited).toBe(0);
        } finally {
          await client.close();
          await remote.stop();
        }
      });
    } finally {
      await cache.close();
    }
  },
  15000,
);
ptyTest(
  "PTY quit serializes after sleep and discards pending work",
  async () => {
    const cache = await cliServer();
    try {
      await withTempDir(async (dir) => {
        const { configPath } = await cliConfig(dir, cache.port);
        const client = terminalClient(configPath);
        try {
          await until(() => /\[0+\//.test(client.output()), client.output);
          await client.send("sleep 0.1\rquit\rquery never-executed\r");
          await until(() => client.child.exitCode !== null, client.output);
          expect(await client.child.exited).toBe(0);
          expect(client.output()).not.toContain("no peers connected");
        } finally {
          await client.close();
        }
      });
    } finally {
      await cache.close();
    }
  },
  10000,
);
