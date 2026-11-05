import { describe, expect, test } from "bun:test";
import { runExecCommands } from "../../../src/cli/runner";
import {
  displayResultCount,
  errMsg,
  parseCli,
  printDownloadInfo,
  printDownloads,
  printPeers,
  printResultInfo,
  printResultMagnet,
  printResults,
  printShares,
  printStatus,
} from "../../../src/cli_shared";
import type { CliNode } from "../../../src/types";

function makeNode(overrides: Partial<CliNode> = {}): CliNode {
  return {
    getPeers: () => [],
    getResults: () => [],
    getResult: (resultNo) => {
      const result = overrides
        .getResults?.("query-id")
        .find((hit) => hit.resultNo === resultNo);
      if (!result) throw new Error(`no such result ${resultNo}`);
      return result;
    },
    getShares: () => [],
    getStatus: () => ({
      peers: 0,
      shares: 0,
      results: 0,
      knownPeers: 0,
    }),
    ...overrides,
  };
}

describe("cli_shared", () => {
  test("formats errors and reports empty or populated status lists", () => {
    const logs: string[] = [];
    const node = makeNode({
      getPeers: () => [
        {
          key: "p1",
          remoteLabel: "1.2.3.4:6346",
          role: "ultrapeer",
          outbound: true,
          userAgent: "Peer/1.0",
          compression: true,
          tls: true,
        },
        {
          key: "p2",
          remoteLabel: "5.6.7.8:6346",
          role: "leaf",
          outbound: false,
          compression: false,
          tls: false,
        },
      ],
      getShares: () => [{ index: 1, size: 123, rel: 'folder/"song".mp3' }],
      getStatus: () => ({
        peers: 2,
        shares: 1,
        results: 1234,
        knownPeers: 9,
      }),
    });

    expect(errMsg(new Error("boom"))).toBe("boom");
    expect(errMsg({ detail: 7 })).toBe("[object Object]");

    printStatus(node, (msg) => logs.push(msg));
    printPeers(makeNode(), (msg) => logs.push(msg));
    printPeers(node, (msg) => logs.push(msg));
    printShares(makeNode(), (msg) => logs.push(msg));
    printShares(node, (msg) => logs.push(msg));
    printResults(makeNode(), (msg) => logs.push(msg), "query-id");

    expect(logs).toEqual([
      "peers=2 shares=1 results=999 knownPeers=9",
      "no peers",
      [
        "Id  Flags  Peer          Agent",
        "--  -----  ------------  --------",
        "p1  OZLU   1.2.3.4:6346  Peer/1.0",
        "p2  I---   5.6.7.8:6346  -",
      ].join("\n"),
      "no shared files",
      '#1 123B "folder/\\"song\\".mp3"',
      "no results",
    ]);
  });

  test("prints results as one aligned table with sizes and full file names", () => {
    const logs: string[] = [];
    const node = makeNode({
      getResults: () => [
        {
          resultNo: 12,
          remoteHost: "10.0.0.2",
          remotePort: 6346,
          fileSize: 1200,
          fileName: "zz-top.bin",
          serventIdHex: "aa".repeat(16),
        },
        {
          resultNo: 2,
          remoteHost: "9.8.7.6",
          remotePort: 1234,
          fileSize: 1,
          fileName: "alpha.txt",
          serventIdHex: "bb".repeat(16),
        },
        {
          resultNo: 7,
          remoteHost: "1.2.3.4",
          remotePort: 80,
          fileSize: 2048,
          fileName: "beta file.bin",
          serventIdHex: "cc".repeat(16),
        },
        {
          resultNo: 8,
          remoteHost: "8.8.8.8",
          remotePort: 6346,
          fileSize: 7777,
          fileName: "12345678901234567890123Xabcdefghijklmnopqrstuvw",
          serventIdHex: "dd".repeat(16),
        },
        {
          resultNo: 21,
          remoteHost: "7.7.7.7",
          remotePort: 6346,
          fileSize: 3758096384,
          fileName: "giant.iso",
          serventIdHex: "ee".repeat(16),
        },
        {
          resultNo: 22,
          remoteHost: "6.6.6.6",
          remotePort: 6346,
          fileSize: 5872026,
          fileName: "medium.dat",
          serventIdHex: "ff".repeat(16),
        },
        {
          resultNo: 23,
          remoteHost: "5.5.5.5",
          remotePort: 6346,
          fileSize: 9895604649984,
          fileName: "archive.tar",
          serventIdHex: "11".repeat(16),
        },
      ],
      getStatus: () => ({
        peers: 0,
        shares: 0,
        results: 7,
        knownPeers: 0,
      }),
    });

    printResults(node, (msg) => logs.push(msg), "query-id");

    expect(logs).toEqual([
      [
        "No      Size  File",
        "--  --------  -----------------------------------------------",
        " 2      1 b   alpha.txt",
        " 7    2.0 kb  beta file.bin",
        " 8    7.6 kb  12345678901234567890123Xabcdefghijklmnopqrstuvw",
        "12    1.2 kb  zz-top.bin",
        "21    3.5 gb  giant.iso",
        "22    5.6 mb  medium.dat",
        "23    9.0 tb  archive.tar",
      ].join("\n"),
    ]);
  });

  test("prints managed download jobs", () => {
    const logs: string[] = [];
    const node = {
      ...makeNode(),
      getDownloadJobs: () => [
        {
          id: "d1",
          status: "active" as const,
          fileName: "alpha.bin",
          fileSize: 10,
          urns: [],
          destPath: "/downloads/alpha.bin",
          incompletePath: "/incomplete/d1-alpha.bin.part",
          bytesCompleted: 5,
          createdAt: "now",
          updatedAt: "now",
          sources: [],
        },
      ],
    };

    printDownloads({ ...makeNode(), getDownloadJobs: () => [] }, (msg) =>
      logs.push(msg),
    );
    printDownloads(node, (msg) => logs.push(msg));

    expect(logs).toEqual([
      "no downloads",
      [
        "Id  Status  Done      Size  File",
        "--  ------  ----  --------  ---------",
        "d1  active   50%     10 b   alpha.bin",
      ].join("\n"),
    ]);
  });

  test("prints detailed result info and errors when missing", () => {
    const logs: string[] = [];
    const node = makeNode({
      getResults: () => [
        {
          resultNo: 12,
          queryIdHex: "aa".repeat(16),
          queryHops: 2,
          remoteHost: "10.0.0.2",
          remotePort: 6346,
          speedKBps: 512,
          fileIndex: 7,
          fileSize: 1200,
          fileName: "zz-top.bin",
          serventIdHex: "bb".repeat(16),
          viaPeerKey: "p7",
          sha1Urn: "urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2",
          urns: ["urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2"],
          metadata: ["128 kbps"],
          vendorCode: "LIME",
          needsPush: false,
          busy: true,
        },
      ],
    });

    printResultInfo(node, 12, (msg) => logs.push(msg));
    printResultMagnet(node, 12, (msg) => logs.push(msg));

    expect(logs).toEqual([
      [
        "result: #12",
        'file: "zz-top.bin"',
        "size: 1.2 kb (1200B)",
        "remote: 10.0.0.2:6346",
        "speed: 512KB/s",
        "file index: 7",
        `servent id: ${"bb".repeat(16)}`,
        `query id: ${"aa".repeat(16)}`,
        "query hops: 2",
        "via peer: p7",
        "sha1 urn: urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2",
        "other urns: -",
        "metadata:",
        "  128 kbps",
        "vendor: LIME",
        "needs push: false",
        "busy: true",
      ].join("\n"),
      "magnet:?xt=urn%3Asha1%3ATXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2&xl=1200&dn=zz-top.bin",
    ]);

    expect(() => printResultInfo(node, 99, () => void 0)).toThrow(
      "no such result 99",
    );
    expect(() => printResultMagnet(node, 99, () => void 0)).toThrow(
      "no such result 99",
    );
  });

  test("shows download details independently of cleared search results", () => {
    const logs: string[] = [];
    const node = {
      ...makeNode(),
      getDownloadJobs: () => [
        {
          id: "d5",
          status: "active" as const,
          fileName: "alpha.bin",
          fileSize: 10,
          bytesCompleted: 4,
          urns: [],
          destPath: "/downloads/alpha.bin",
          incompletePath: "/incomplete/d5.part",
          createdAt: "2026-09-22T12:00:00Z",
          updatedAt: "2026-09-22T12:01:00Z",
          activeSourceId: "s1",
          sources: [
            {
              id: "s1",
              resultNo: 740,
              queryIdHex: "aa".repeat(16),
              queryHops: 1,
              remoteHost: "127.0.0.1",
              remotePort: 6346,
              speedKBps: 256,
              fileIndex: 1,
              fileName: "alpha.bin",
              fileSize: 10,
              serventIdHex: "bb".repeat(16),
              viaPeerKey: "p1",
              attempts: 2,
              failuresWithoutProgress: 1,
              lastError: "download timeout",
              vendorCode: "GTKG",
              needsPush: false,
            },
          ],
        },
      ],
    };
    printDownloadInfo(node, "d5", (message) => logs.push(message));
    expect(logs[0]).toContain("download: d5\nstatus: active");
    expect(logs[0]).toContain("progress: 40% (4/10B)");
    expect(logs[0]).toContain("active source: s1");
    expect(logs[0]).toContain("s1: 127.0.0.1:6346");
    expect(logs[0]).toContain("original result: #740");
    expect(logs[0]).toContain("attempts: 2");
    expect(logs[0]).toContain("consecutive attempts without progress: 1");
    expect(logs[0]).toContain('last error: "download timeout"');
    expect(logs[0]).toContain('partial file: "/incomplete/d5.part"');
    expect(() => printDownloadInfo(node, "d9", () => {})).toThrow(
      "no such download d9",
    );
  });

  test("caps displayed result counts at 999", () => {
    expect(displayResultCount(-5)).toBe(0);
    expect(displayResultCount(17)).toBe(17);
    expect(displayResultCount(999)).toBe(999);
    expect(displayResultCount(1000)).toBe(999);
    expect(displayResultCount(1234.9)).toBe(999);
  });

  test("parses CLI args with config overrides and queued exec commands", () => {
    expect(
      parseCli(
        [
          "init",
          "--config",
          "custom.json",
          "--exec",
          "query alpha",
          "ignored",
          "--exec",
        ],
        "gnutella.json",
      ),
    ).toEqual({
      command: "init",
      config: "custom.json",
      exec: ["query alpha", ""],
      version: false,
    });

    expect(parseCli(["--config"], "default.json")).toEqual({
      command: "run",
      config: "default.json",
      exec: [],
      version: false,
    });
  });

  test("parses version flags without interpreting option values as flags", () => {
    for (const flag of ["-v", "--version"]) {
      expect(parseCli([flag], "default.json").version).toBe(true);
      expect(parseCli(["run", flag], "default.json").version).toBe(true);
      expect(parseCli(["--config", flag], "default.json").version).toBe(
        false,
      );
      expect(parseCli(["--exec", flag], "default.json").version).toBe(
        false,
      );
    }
  });

  test("runs exec commands after sleeping, logs failures, and stops on false", async () => {
    const logs: string[] = [];
    const sleeps: number[] = [];
    const commands: string[] = [];

    runExecCommands(
      ["explode", "stop", "skip"],
      (msg) => logs.push(msg),
      async (ms) => {
        sleeps.push(ms);
      },
      async (line) => {
        commands.push(line);
        if (line === "explode") throw new Error("boom");
        return line !== "stop";
      },
      errMsg,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sleeps).toEqual([500]);
    expect(commands).toEqual(["explode", "stop"]);
    expect(logs).toEqual([
      "exec> explode",
      "command failed: boom",
      "exec> stop",
    ]);
  });

  test("skips exec scheduling when no commands are provided", () => {
    let slept = false;
    let ran = false;

    runExecCommands(
      [],
      () => {
        throw new Error("unexpected log");
      },
      async () => {
        slept = true;
      },
      async () => {
        ran = true;
        return true;
      },
      errMsg,
    );

    expect(slept).toBe(false);
    expect(ran).toBe(false);
  });
});
