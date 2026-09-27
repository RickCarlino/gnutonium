import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createCacheState } from "../../src/discovery/gwebcache/state";
import type { GnutellaEvent } from "../../src/types";
import { captureNetwork } from "./capture";

const revision = "3ce50bf0dd25e88e0d470eda61a0283a23ed49c6";
const gtk = process.env.GTK_GNUTELLA_BIN ?? "/usr/local/bin/gtk-gnutella";
const xvfb = process.env.XVFB_BIN ?? "Xvfb";
const sourceRoot =
  process.env.GNUTONIUM_SOURCE_ROOT ?? path.resolve(__dirname, "../..");
const gtkLeaf = process.env.INTEROP_GTK_ROLE === "leaf";
const tls = process.env.INTEROP_TLS !== "0";
const compression = process.env.INTEROP_COMPRESSION !== "0";

async function output(
  command: string[],
  input?: string,
  env = process.env,
): Promise<string> {
  const proc = Bun.spawn(command, {
    env,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 15000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0)
      throw new Error(`${command[0]} exited ${code}: ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function until(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeout = 20000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`interop timeout: ${label}`);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function prerequisites() {
  assert.equal(
    process.env.GNUTONIUM_INTEROP_ISOLATED,
    "1",
    "run via bun run test:interop",
  );
  const links: Array<{ ifname: string }> = JSON.parse(
    await output(["ip", "-json", "link", "show"]),
  );
  assert.deepEqual(
    links.map((link) => link.ifname),
    ["lo"],
    "interop requires a loopback-only namespace",
  );
  assert.equal(
    (await output(["ip", "route", "show", "default"])).trim(),
    "",
  );
  const version = await output([gtk, "--version"]);
  const build = await output([gtk, "--compile-info"]);
  assert.match(version, /gtk-gnutella\/1\.3\.1 /);
  assert.match(build, /user-interface=GTK2/);
  if (tls)
    assert.match(
      build,
      /gnutls=enabled/,
      "TLS interop requires a GnuTLS-enabled GTK build",
    );
  const checksum = crypto
    .createHash("sha256")
    .update(await fs.readFile(gtk))
    .digest("hex");
  const expected = process.env.GTK_GNUTELLA_SHA256;
  assert.ok(
    expected,
    "set GTK_GNUTELLA_SHA256 to the pinned build checksum",
  );
  assert.equal(
    checksum,
    expected,
    "GTK binary differs from the pinned build",
  );
  return {
    revision,
    checksum,
    version,
    build,
    tls,
    compression,
    sourceRoot,
  };
}

async function connectClients(
  node: import("../../src/protocol").GnutellaServent,
  anchor: import("../../src/protocol").GnutellaServent | undefined,
  shell: (command: string) => Promise<string>,
): Promise<void> {
  await node.start();
  if (anchor) {
    await anchor.start();
    await anchor.connectToPeer("10.44.0.2:16346");
    await until("GTK mesh connection", () => anchor.getPeers().length > 0);
  }
  if (gtkLeaf) await shell("node add 10.44.0.1:16347");
  else await node.connectToPeer("10.44.0.2:16346");
  await until("connection", () => node.getPeers().length > 0);
  assert.equal(node.getPeers()[0]?.tls, tls, "unexpected TLS negotiation");
  assert.equal(
    node.getPeers()[0]?.compression,
    compression,
    "unexpected compression negotiation",
  );
}

async function run() {
  const provenance = await prerequisites();
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "gnutonium-interop-"),
  );
  console.log(`Interop artifacts: ${dir}`);
  const gtkDir = path.join(dir, "gtk");
  const gtkShares = path.join(dir, "gtk-shares");
  const gtkComplete = path.join(dir, "gtk-complete");
  const gtkPartial = path.join(dir, "gtk-partial");
  const bunShares = path.join(dir, "bun-shares");
  for (const folder of [
    gtkDir,
    gtkShares,
    gtkComplete,
    gtkPartial,
    bunShares,
  ])
    await fs.mkdir(folder);
  const content = Buffer.from(
    "synthetic gnutonium interoperability content\n".repeat(4096),
  );
  await fs.writeFile(
    path.join(gtkShares, "gtk-interop-sample.txt"),
    content,
  );
  await fs.writeFile(
    path.join(bunShares, "bun-interop-sample.txt"),
    Buffer.from("synthetic Bun upload content\n".repeat(4096)),
  );
  await fs.writeFile(
    path.join(bunShares, "bun-interop-pushed.txt"),
    Buffer.from("synthetic push upload\n".repeat(4096)),
  );
  await fs.writeFile(
    path.join(gtkDir, "config_gnet"),
    [
      "listen_port = 16346",
      "network_protocol = 4",
      "forced_local_ip = 10.44.0.2",
      "force_local_ip = TRUE",
      "bind_to_forced_local_ip = TRUE",
      `configured_peermode = ${gtkLeaf ? 0 : 2}`,
      "up_connections = 1",
      "prefer_compressed_gnet = FALSE",

      `gnet_deflate_enabled = ${compression ? "TRUE" : "FALSE"}`,
      "enable_udp = FALSE",
      "enable_dht = FALSE",
      "enable_g2 = FALSE",
      "search_debug = 2",
      "enable_upnp = FALSE",
      "enable_natpmp = FALSE",
      "enable_shell = FALSE",
      "enable_local_socket = TRUE",
      "browse_host_enabled = TRUE",
      'local_netmasks = "10.44.0.0/24"',
      'shared_files_extensions = "txt"',
      `shared_dirs = "${gtkShares}"`,
      `store_downloading_files_to = "${gtkPartial}"`,
      `move_downloading_files_to = "${gtkComplete}"`,
    ].join("\n") + "\n",
  );
  const displayNo = 1000 + Math.floor(Math.random() * 30000);
  const display = `:${displayNo}`;
  assert.equal(await exists(`/tmp/.X11-unix/X${displayNo}`), false);
  const displayProcess = Bun.spawn(
    [xvfb, display, "-screen", "0", "1024x768x24", "-nolisten", "tcp"],
    {
      stdout: Bun.file(path.join(dir, "xvfb.log")),
      stderr: Bun.file(path.join(dir, "xvfb-stderr.log")),
    },
  );
  const env = {
    ...process.env,
    GTK_GNUTELLA_DIR: gtkDir,
    DISPLAY: display,
  };
  let gtkProcess: ReturnType<typeof Bun.spawn> | undefined;
  const { GnutellaServent, defaultDoc } = (await import(
    path.join(sourceRoot, "src/protocol.ts")
  )) as {
    GnutellaServent: typeof import("../helpers/servent").TestServent;
    defaultDoc: typeof import("../../src/protocol").defaultDoc;
  };
  const configPath = path.join(dir, "gnutella.json");
  const events: GnutellaEvent[] = [];
  const capture = captureNetwork();
  const node = new GnutellaServent(configPath, defaultDoc(configPath), {
    collaborators: { netFactory: capture.netFactory },
    runtimeConfig: {
      listenHost: "10.44.0.1",
      listenPort: 16347,
      advertisedHost: "10.44.0.1",
      advertisedPort: 16347,
      downloadsDir: bunShares,
      dataDir: path.join(dir, "bun-data"),
      incompleteDownloadsDir: path.join(dir, "bun-partial"),
      gwebCaches: createCacheState([]),
      nodeMode: gtkLeaf ? "ultrapeer" : "leaf",
      ultrapeer: gtkLeaf,
      enableTls: tls,
      enableCompression: compression,
      reconnectIntervalSec: 3600,
    },
    onEvent: (event) => events.push(event),
  });
  const anchorPath = path.join(dir, "anchor.json");
  const anchor = gtkLeaf
    ? undefined
    : new GnutellaServent(anchorPath, defaultDoc(anchorPath), {
        collaborators: { netFactory: capture.netFactory },
        runtimeConfig: {
          listenHost: "10.44.0.1",
          listenPort: 16348,
          advertisedHost: "10.44.0.1",
          advertisedPort: 16348,
          downloadsDir: path.join(dir, "anchor-shares"),
          dataDir: path.join(dir, "anchor-data"),
          incompleteDownloadsDir: path.join(dir, "anchor-partial"),
          gwebCaches: createCacheState([]),
          nodeMode: "ultrapeer",
          ultrapeer: true,
          enableTls: tls,
          enableCompression: compression,
          reconnectIntervalSec: 3600,
        },
      });
  const shell = async (command: string) => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(path.join(gtkDir, "ipc/socket"));
      let received = "";
      socket.setTimeout(15000, () =>
        socket.destroy(new Error("GTK shell timeout")),
      );
      socket.on("connect", () =>
        socket.write("HELO\nINTR\n" + command + "\nquit\n"),
      );
      socket.on("data", (chunk) => {
        received += chunk.toString();
      });
      socket.on("error", reject);
      socket.on("end", () => {
        socket.destroy();
        resolve(received);
      });
    });
    await fs.appendFile(
      path.join(dir, "shell.log"),
      `${command}\n${response}\n`,
    );
    return response;
  };
  let passed = false;
  const scenarios: Array<{
    name: string;
    passed: boolean;
    error?: string;
  }> = [];
  const scenario = async (name: string, check: () => Promise<void>) => {
    try {
      await check();
      scenarios.push({ name, passed: true });
      console.log(`PASS: ${name}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      scenarios.push({ name, passed: false, error: message });
      console.error(`FAIL: ${name}: ${message}`);
    }
  };
  try {
    await until("virtual display", () =>
      exists(`/tmp/.X11-unix/X${displayNo}`),
    );
    gtkProcess = Bun.spawn(
      [gtk, "--no-supervise", "--no-restart", "--no-dbus"],
      {
        env,
        stdout: Bun.file(path.join(dir, "gtk.log")),
        stderr: Bun.file(path.join(dir, "gtk-stderr.log")),
      },
    );
    await until("GTK control socket", () =>
      exists(path.join(gtkDir, "ipc/socket")),
    );
    await connectClients(node, anchor, shell);
    await Bun.sleep(1000);
    let browseId = "";
    await until("GTK shared catalog", async () => {
      if (browseId) node.clearResults(browseId);
      browseId = (await node.browsePeer(node.getPeers()[0]!.key)).id;
      return node
        .getResults(browseId)
        .some((hit) => hit.fileName === "gtk-interop-sample.txt");
    });
    scenarios.push({ name: "connection and browse", passed: true });
    const browsed = node
      .getResults(browseId)
      .find((hit) => hit.fileName === "gtk-interop-sample.txt")!;
    await scenario("download from GTK", async () => {
      const job = await node.downloadResult(browsed.resultNo);
      await until(
        "download from GTK",
        () =>
          node.getDownloadJobs().find((entry) => entry.id === job.id)
            ?.status === "complete",
      );
      assert.deepEqual(await fs.readFile(job.destPath), content);
    });
    await scenario("resume partial download from GTK", async () => {
      const destination = path.join(dir, "resumed-from-gtk.txt");
      await fs.writeFile(destination, content.subarray(0, 32768));
      await node.transfers.directDownload(browsed, destination);
      assert.deepEqual(await fs.readFile(destination), content);
    });
    await scenario("push download from GTK", async () => {
      const destination = path.join(dir, "pushed-from-gtk.txt");
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 20000);
      try {
        await node.transfers.sendPush(browsed, destination, {
          signal: abort.signal,
        });
        assert.deepEqual(await fs.readFile(destination), content);
      } finally {
        clearTimeout(timer);
      }
    });
    await scenario("search GTK shares", async () => {
      await until(
        "GTK routing table",
        () =>
          !gtkLeaf ||
          [...node.connections.peers.values()].some(
            (peer) => !!node.router.peerState(peer).qrp.table,
          ),
        60000,
      );
      const search = node.sendQuery("gtk interop sample")!;
      await until("GTK search result", () =>
        node
          .getResults(search.id)
          .some((hit) => hit.fileName === "gtk-interop-sample.txt"),
      );
    });
    await scenario("hash search GTK shares", async () => {
      assert.ok(browsed.sha1Urn, "GTK browse did not supply a SHA1 URN");
      const search = node.sendQuery(
        `gtk interop sample ${browsed.sha1Urn}`,
      )!;
      await until("GTK hash search result", () =>
        node
          .getResults(search.id)
          .some((hit) => hit.sha1Urn === browsed.sha1Urn),
      );
    });
    await scenario("GTK-originated search", async () => {
      await shell("set is_firewalled FALSE");
      await shell('search add "bun interop sample"');
      await until("GTK-originated search", () =>
        events.some(
          (event) =>
            event.type === "QUERY_RECEIVED" &&
            event.search.includes("bun interop sample"),
        ),
      );
    });
    await scenario("GTK accepts search results", async () => {
      await until("GTK GUI retained search result", async () =>
        /SCH GUI reported [1-9]\d* new kept results for "bun interop sample"/.test(
          await fs.readFile(path.join(dir, "gtk-stderr.log"), "utf8"),
        ),
      );
    });
    await scenario("push upload to GTK", async () => {
      const share = node
        .getShares()
        .find((item) => item.name === "bun-interop-pushed.txt")!;
      await shell("set is_firewalled FALSE");
      const source = `push://${node.getServentIdHex()}/get/${share.index}/${share.name}`;
      await shell(
        `download add "magnet:?dn=${share.name}&xt=${share.sha1Urn}&xl=${share.size}&xs=${encodeURIComponent(source)}"`,
      );
      const received = path.join(gtkComplete, share.name);
      await until(
        "GTK completed push download",
        () => exists(received),
        30000,
      );
      assert.deepEqual(
        await fs.readFile(received),
        await fs.readFile(path.join(bunShares, share.name)),
      );
    });
    await scenario("download to GTK", async () => {
      const share = node
        .getShares()
        .find((share) => share.name === "bun-interop-sample.txt")!;
      await shell(
        `download add "magnet:?dn=${share.name}&xt=${share.sha1Urn}&xl=${share.size}&xs=${encodeURIComponent(`http://10.44.0.1:16347/get/${share.index}/${share.name}`)}"`,
      );
      const received = path.join(gtkComplete, share.name);
      await until("GTK completed download", () => exists(received), 30000);
      assert.deepEqual(
        await fs.readFile(received),
        await fs.readFile(path.join(bunShares, share.name)),
      );
    });
    assert.ok(
      scenarios.every((result) => result.passed),
      "one or more GTK scenarios failed",
    );
    passed = true;
    console.log(
      "PASS: connection, browse, bidirectional search requests and completed transfers",
    );
  } finally {
    await fs.writeFile(
      path.join(dir, "evidence.json"),
      JSON.stringify(
        {
          ...provenance,
          gtkLeaf,
          passed,
          scenarios,
          events,
          exchanges: capture.exchanges,
        },
        null,
        2,
      ),
    );
    try {
      await node.stop();
      await anchor?.stop();
    } finally {
      gtkProcess?.kill();
      if (gtkProcess) await gtkProcess.exited;
      displayProcess.kill();
      await displayProcess.exited;
    }
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
