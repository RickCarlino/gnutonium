import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { completionContext, readlineCompletion } from "./cli/complete";
import { CommandRunner, runExecCommands } from "./cli/runner";
import { watchStatus } from "./cli/status";
import { monitorAllowsEvent, type MonitorMode } from "./cli_monitor";
import { displayResultCount, errMsg, parseCli } from "./cli_shared";
import {
  CLI_SHUTDOWN_TIMEOUT_MS,
  PROMPT_THROBBER_FRAMES,
  PROMPT_THROBBER_INTERVAL_MS,
} from "./const";
import { GnutellaServent, loadDoc, writeDoc } from "./protocol";
import { sleep } from "./shared";
import type { GnutellaEvent } from "./types";

type MonitorLogEntry = {
  line: string;
  tags: string[];
};

type CliSession = {
  rl: readline.Interface | null;
  node: GnutellaServent;
  runner: CommandRunner | null;
  monitorMode: MonitorMode;
  monitorIgnoreTokens: Set<string>;
  promptFrame: number;
  promptTimer: ReturnType<typeof setTimeout> | null;
  promptInitial: boolean;
  shutdown: (() => Promise<void>) | null;
};

function createCliSession(node: GnutellaServent): CliSession {
  return {
    rl: null,
    node,
    runner: null,
    monitorMode: "off",
    monitorIgnoreTokens: new Set<string>(),
    promptFrame: PROMPT_THROBBER_FRAMES.length - 1,
    promptTimer: null,
    promptInitial: true,
    shutdown: null,
  };
}

function padNum(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function promptThrobber(session: CliSession): string {
  if (session.promptInitial) return " ";
  return PROMPT_THROBBER_FRAMES[session.promptFrame] || " ";
}

function peerLimitDisplay(node: GnutellaServent): number {
  const c = node.config();
  if (c.nodeMode === "ultrapeer") return c.maxConnections;
  if (c.nodeMode === "leaf") return c.maxUltrapeerConnections;
  return c.maxConnections;
}

function promptText(session: CliSession): string {
  const status = session.node.getStatus();
  const peerLimit = peerLimitDisplay(session.node);
  const peerWidth = Math.max(
    2,
    String(status.peers).length,
    String(peerLimit).length,
  );
  return `[${padNum(status.peers, peerWidth)}/${padNum(peerLimit, peerWidth)}${promptThrobber(session)}${padNum(displayResultCount(status.results), 3)}] `;
}

function stopPromptThrobber(session: CliSession): void {
  if (session.promptTimer) clearTimeout(session.promptTimer);
  session.promptTimer = null;
  session.promptFrame = PROMPT_THROBBER_FRAMES.length - 1;
  session.promptInitial = true;
}

function stepPromptThrobber(session: CliSession): void {
  if (session.promptFrame >= PROMPT_THROBBER_FRAMES.length - 1) {
    session.promptTimer = null;
    redrawPrompt(session);
    return;
  }
  session.promptTimer = setTimeout(() => {
    session.promptFrame++;
    redrawPrompt(session);
    stepPromptThrobber(session);
  }, PROMPT_THROBBER_INTERVAL_MS);
}

function throbPrompt(session: CliSession): void {
  session.promptInitial = false;
  if (!process.stdin.isTTY) return;
  if (session.promptTimer) clearTimeout(session.promptTimer);
  session.promptFrame = 0;
  redrawPrompt(session);
  stepPromptThrobber(session);
}

function redrawPrompt(session: CliSession): void {
  if (!session.rl || !process.stdin.isTTY) return;
  session.rl.setPrompt(promptText(session));
  session.rl.prompt(true);
}

function log(session: CliSession, msg: string): void {
  if (session.rl && process.stdin.isTTY) {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  }
  process.stdout.write(`${msg}\n`);
  redrawPrompt(session);
}

function shortDescriptorId(hex: string): string {
  return hex.slice(0, 8);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function describePeer(
  event: Extract<GnutellaEvent, { peer: { remoteLabel: string } }>,
): string {
  const parts = [
    event.peer.remoteLabel,
    `dir=${event.peer.outbound ? "out" : "in"}`,
    `flags=${event.peer.compression ? "Z" : "-"}${event.peer.tls ? "L" : "-"}`,
  ];
  if (event.peer.userAgent)
    parts.push(`agent=${quoted(event.peer.userAgent)}`);
  return parts.join(" ");
}

function monitorEntry(line: string, ...tags: string[]): MonitorLogEntry {
  return { line, tags };
}

function setMonitorIgnoreTokens(
  session: CliSession,
  tokens: string[],
): void {
  session.monitorIgnoreTokens = new Set(tokens);
}

function shouldIgnoreMonitorEntry(
  session: CliSession,
  entry: MonitorLogEntry,
): boolean {
  return entry.tags.some((tag) => session.monitorIgnoreTokens.has(tag));
}

function formatLifecycleMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  switch (event.type) {
    case "NAT_STATUS":
      return monitorEntry(
        `[upnp] ${event.state}: ${event.message}`,
        "NAT_STATUS",
      );
    case "STARTED":
      return monitorEntry(
        `[started] listen=${event.listenHost}:${event.listenPort} advertised=${event.advertisedHost}:${event.advertisedPort}`,
        "STARTED",
      );
    case "IDENTITY":
      return monitorEntry(
        `[identity] serventId=${event.serventIdHex}`,
        "IDENTITY",
      );
    case "SHARES_REFRESHED":
      return monitorEntry(
        `[shares] count=${event.count} totalKiB=${event.totalKBytes}`,
        "SHARES_REFRESHED",
      );
    case "MAINTENANCE_ERROR":
      return monitorEntry(
        `[maintenance] op=${event.operation} message=${quoted(event.message)}`,
        "MAINTENANCE_ERROR",
      );
    case "PROBE_REJECTED":
      return monitorEntry(
        `[probe rejected] message=${quoted(event.message)}`,
        "PROBE_REJECTED",
      );
  }
}

function formatHandshakeMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  if (event.type !== "HANDSHAKE_DEBUG") return;
  const prefix = event.phase.includes("failed") ? "[warning] " : "";
  return monitorEntry(
    `${prefix}[hs ${event.direction} ${event.phase}] peer=${event.peer} ${event.message}`,
    "HANDSHAKE",
    `HANDSHAKE:${event.direction.toUpperCase()}`,
    `HANDSHAKE:${event.phase.toUpperCase()}`,
  );
}

function formatPeerMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  switch (event.type) {
    case "PEER_CONNECTED":
      return monitorEntry(
        `[peer up] ${describePeer(event)}`,
        "PEER_CONNECTED",
      );
    case "PEER_DROPPED":
      return monitorEntry(
        `[peer down] ${describePeer(event)} message=${quoted(event.message)}`,
        "PEER_DROPPED",
      );
    case "PEER_MESSAGE_RECEIVED":
      return monitorEntry(
        `[rx] ${event.payloadTypeName} id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl} hops=${event.hops} len=${event.payloadLength} from=${event.peer.remoteLabel}`,
        "PEER_MESSAGE_RECEIVED",
        event.payloadTypeName,
        `RX:${event.payloadTypeName}`,
      );
    case "PEER_MESSAGE_SENT":
      return monitorEntry(
        `[tx] ${event.payloadTypeName} id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl} hops=${event.hops} len=${event.payloadLength} to=${event.peer.remoteLabel}`,
        "PEER_MESSAGE_SENT",
        event.payloadTypeName,
        `TX:${event.payloadTypeName}`,
      );
    case "PONG":
      return monitorEntry(
        `[pong] ${event.ip}:${event.port} files=${event.files} kbytes=${event.kbytes}`,
        "PONG",
        "EVENT:PONG",
      );
  }
}

function formatQueryMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  switch (event.type) {
    case "QUERY_RECEIVED":
      return monitorEntry(
        `[query rx] id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl} hops=${event.hops} from=${event.peer.remoteLabel} urns=${event.urns.length} search=${quoted(event.search)}`,
        "QUERY_RECEIVED",
        "EVENT:QUERY_RECEIVED",
        "QUERY",
        "RX:QUERY",
      );
    case "QUERY_RESULT":
      return monitorEntry(
        `[query hit] query=${shortDescriptorId(event.hit.queryIdHex)} #${event.hit.resultNo} via=${event.hit.viaPeerKey} remote=${event.hit.remoteHost}:${event.hit.remotePort} size=${event.hit.fileSize} name=${quoted(event.hit.fileName)}`,
        "QUERY_RESULT",
        "EVENT:QUERY_RESULT",
        "QUERY_HIT",
      );
    case "PING_SENT":
      return monitorEntry(
        `[ping tx] id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl}`,
        "PING_SENT",
        "EVENT:PING_SENT",
        "PING",
        "TX:PING",
      );
    case "QUERY_SENT":
      return monitorEntry(
        `[query tx] id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl} search=${quoted(event.search)}`,
        "QUERY_SENT",
        "EVENT:QUERY_SENT",
        "QUERY",
        "TX:QUERY",
      );
    case "QUERY_SKIPPED":
      return monitorEntry(
        `[query skip] reason=${event.reason}`,
        "QUERY_SKIPPED",
      );
  }
}

function formatDownloadJobMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  switch (event.type) {
    case "DOWNLOAD_QUEUED":
      return monitorEntry(
        `[download queued] job=${event.jobId} result=${event.resultNo} path=${quoted(event.destPath)} name=${quoted(event.fileName)}`,
        "DOWNLOAD_QUEUED",
      );
    case "DOWNLOAD_STARTED":
      return monitorEntry(
        `[download start] job=${event.jobId} remote=${event.remoteHost}:${event.remotePort} name=${quoted(event.fileName)}`,
        "DOWNLOAD_STARTED",
      );
    case "DOWNLOAD_PAUSED":
      return monitorEntry(
        `[download paused] job=${event.jobId} name=${quoted(event.fileName)}`,
        "DOWNLOAD_PAUSED",
      );
    case "DOWNLOAD_RESUMED":
      return monitorEntry(
        `[download resumed] job=${event.jobId} name=${quoted(event.fileName)}`,
        "DOWNLOAD_RESUMED",
      );
    case "DOWNLOAD_REMOVED":
      return monitorEntry(
        `[download removed] job=${event.jobId} name=${quoted(event.fileName)}`,
        "DOWNLOAD_REMOVED",
      );
    case "DOWNLOAD_FAILED":
      return monitorEntry(
        `[download failed] job=${event.jobId} name=${quoted(event.fileName)} message=${quoted(event.message)}`,
        "DOWNLOAD_FAILED",
      );
    case "DOWNLOAD_VERIFICATION_FAILED":
      return monitorEntry(
        `[download verify failed] job=${event.jobId} path=${quoted(event.destPath)} name=${quoted(event.fileName)}`,
        "DOWNLOAD_VERIFICATION_FAILED",
      );
  }
}

function formatTransferMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  switch (event.type) {
    case "PUSH_REQUESTED":
      return monitorEntry(
        `[push requested] fileIndex=${event.fileIndex} ip=${event.ip}:${event.port} name=${quoted(event.fileName)}`,
        "PUSH_REQUESTED",
        "PUSH",
      );
    case "PUSH_CALLBACK_FAILED":
      return monitorEntry(
        `[push callback failed] message=${quoted(event.message)}`,
        "PUSH_CALLBACK_FAILED",
      );
    case "PUSH_UPLOAD_FAILED":
      return monitorEntry(
        `[push upload failed] message=${quoted(event.message)}`,
        "PUSH_UPLOAD_FAILED",
      );
    case "DOWNLOAD_SUCCEEDED":
      return monitorEntry(
        `[download ok] mode=${event.mode} result=${event.resultNo} remote=${event.remoteHost}:${event.remotePort} path=${quoted(event.destPath)}`,
        "DOWNLOAD_SUCCEEDED",
      );
    case "DOWNLOAD_DIRECT_FAILED":
      return monitorEntry(
        `[download failed] result=${event.resultNo} remote=${event.remoteHost}:${event.remotePort} path=${quoted(event.destPath)} message=${quoted(event.message)}`,
        "DOWNLOAD_DIRECT_FAILED",
      );
  }
}

function formatMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  return (
    formatLifecycleMonitorEvent(event) ||
    formatHandshakeMonitorEvent(event) ||
    formatPeerMonitorEvent(event) ||
    formatQueryMonitorEvent(event) ||
    formatDownloadJobMonitorEvent(event) ||
    formatTransferMonitorEvent(event)
  );
}

function handleNodeEvent(session: CliSession, event: GnutellaEvent): void {
  if (!monitorAllowsEvent(session.monitorMode, event)) {
    if (event.type === "PEER_MESSAGE_RECEIVED") {
      throbPrompt(session);
      return;
    }
    redrawPrompt(session);
    return;
  }
  const entry = formatMonitorEvent(event);
  if (entry) {
    if (shouldIgnoreMonitorEntry(session, entry)) {
      if (event.type === "PEER_MESSAGE_RECEIVED") throbPrompt(session);
      else redrawPrompt(session);
      return;
    }
    log(session, entry.line);
    return;
  }
  redrawPrompt(session);
}

function startRepl(
  session: CliSession,
  execCmds: string[],
): readline.Interface | null {
  const runner = new CommandRunner({
    node: session.node,
    log: (msg) => log(session, msg),
    sleep,
    shutdown: async () => {
      await session.shutdown?.();
    },
    monitor: {
      get: () => session.monitorMode,
      set: (mode) => {
        session.monitorMode = mode;
      },
    },
  });
  session.runner = runner;
  runExecCommands(
    execCmds,
    (msg) => log(session, msg),
    sleep,
    async (cmd) => (await runner.submit(cmd)).keepRunning,
    errMsg,
  );
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptText(session),
    completer: (prefix: string) =>
      readlineCompletion(
        prefix,
        session.rl?.line ?? prefix,
        completionContext(session.node),
      ),
  });
  session.rl = rl;
  rl.on("SIGINT", () => {
    void session.shutdown?.();
  });
  rl.on("line", (line) => {
    void runner
      .submit(line)
      .then((outcome) => {
        if (outcome.keepRunning) redrawPrompt(session);
      })
      .catch((e) => {
        log(session, errMsg(e));
      });
  });
  rl.on("close", () => {
    if (session.rl === rl) session.rl = null;
    stopPromptThrobber(session);
  });
  redrawPrompt(session);
  return rl;
}

/** Run CLI initialization, scripted commands, or interactive mode. */
export async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv, "gnutella.json");
  if (cli.command === "status") {
    if (cli.exec.length) throw new Error("status does not accept --exec");
    await watchStatus(cli.config);
    return;
  }
  if (cli.command === "init") {
    const doc = await loadDoc(cli.config);
    await writeDoc(cli.config, doc);
    console.log(path.resolve(cli.config));
    return;
  }
  if (cli.command !== "run")
    throw new Error(`unsupported command ${cli.command}`);

  const doc = await loadDoc(cli.config);
  const node = new GnutellaServent(cli.config, doc);
  const session = createCliSession(node);
  node.subscribe((event) => handleNodeEvent(session, event));
  setMonitorIgnoreTokens(session, node.config().monitorIgnoreEvents);

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return await shutdownPromise;
    shutdownPromise = (async () => {
      session.runner?.stop();
      session.rl?.close();
      let stopFinished = false;
      let stopFailed = false;
      const stopPromise = node
        .stop()
        .then(() => {
          stopFinished = true;
        })
        .catch((e) => {
          stopFailed = true;
          stopFinished = true;
          process.stderr.write(`shutdown error: ${errMsg(e)}\n`);
        });
      await Promise.race([stopPromise, sleep(CLI_SHUTDOWN_TIMEOUT_MS)]);
      if (!stopFinished) {
        process.stderr.write(
          `shutdown timed out after ${CLI_SHUTDOWN_TIMEOUT_MS}ms; forcing exit\n`,
        );
      }
      process.exit(stopFailed ? 1 : 0);
    })();
    return await shutdownPromise;
  };
  session.shutdown = shutdown;

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await node.start();
  const rl = startRepl(session, cli.exec);
  rl?.on("close", () => {
    void shutdown();
  });
}
