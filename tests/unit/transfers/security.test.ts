import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { safeTerminalText } from "../../../src/cli/output";
import { safeFileName } from "../../../src/shared";
import {
  openDownloadFile,
  openSharedFile,
} from "../../../src/transfers/file_access";
import { boundedHttpHeaderEnd } from "../../../src/wire/http";
import { withTempDir } from "../../helpers/protocol";

describe("untrusted transfer inputs", () => {
  test.each([
    ["../../secret", ".._.._secret"],
    ["..\\..\\secret", ".._.._secret"],
    ["C:\\secret", "C__secret"],
    ["song.txt:payload.exe", "song.txt_payload.exe"],
    ["NUL.txt", "_NUL.txt"],
    ["com1", "_com1"],
    ["LPT¹.log", "_LPT¹.log"],
    ["CON .txt", "_CON .txt"],
    ["... ", "_"],
    ["", "_"],
    ["file. ", "file"],
    ["song\r\n.txt", "song__.txt"],
    ["音楽 🎵.flac", "音楽 🎵.flac"],
  ])("normalizes %j to one portable filename", (input, expected) => {
    const name = safeFileName(input);
    expect(name).toBe(expected);
    expect(path.posix.dirname(name)).toBe(".");
    expect(path.win32.dirname(name)).toBe(".");
  });

  test("rejects oversized headers but accepts large bodies after small headers", () => {
    expect(() => boundedHttpHeaderEnd("x".repeat(65536))).toThrow(
      "headers too large",
    );
    expect(() =>
      boundedHttpHeaderEnd(`${"x".repeat(65536)}\r\n\r\n`),
    ).toThrow();
    const head = "HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n";
    expect(boundedHttpHeaderEnd(head + "x".repeat(100000))).toBe(
      head.length,
    );
    expect(boundedHttpHeaderEnd(head.slice(0, -1))).toBe(-1);
  });

  test("neutralizes terminal controls while preserving multiline text", () => {
    const raw =
      "name\x1b]52;c;cGF5bG9hZA==\x07\x9b2J\r\b\u202eevil\nnext\tcell";
    const cleaned = safeTerminalText(raw);
    expect(cleaned).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/);
    expect(cleaned).toContain("evil\nnext\tcell");
  });

  test("rejects symlink and hardlink download destinations before truncation", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "secret");
      await fsp.writeFile(target, "keep");
      for (const kind of ["symlink", "hardlink"] as const) {
        const dest = path.join(dir, kind);
        if (kind === "symlink") await fsp.symlink(target, dest);
        else await fsp.link(target, dest);
        expect(() => openDownloadFile(dest, 0)).toThrow();
        expect(await fsp.readFile(target, "utf8")).toBe("keep");
      }
    });
  });

  test("opens regular downloads for resume and restart with private permissions", async () => {
    await withTempDir(async (dir) => {
      const dest = path.join(dir, "download");
      let fd = openDownloadFile(dest, 0);
      fs.writeSync(fd, "abc");
      fs.closeSync(fd);
      fd = openDownloadFile(dest, 3);
      fs.writeSync(fd, "d", 3);
      fs.closeSync(fd);
      expect(await fsp.readFile(dest, "utf8")).toBe("abcd");
      fd = openDownloadFile(dest, 0);
      fs.closeSync(fd);
      expect((await fsp.stat(dest)).size).toBe(0);
      if (process.platform !== "win32")
        expect((await fsp.stat(dest)).mode & 0o777).toBe(0o600);
    });
  });

  test("rejects shared files redirected through a parent directory symlink", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, "shared");
      const outside = path.join(dir, "shared-other");
      await fsp.mkdir(root);
      await fsp.mkdir(outside);
      await fsp.writeFile(path.join(outside, "secret"), "private");
      await fsp.symlink(outside, path.join(root, "sub"), "dir");
      await expect(
        openSharedFile(path.join(root, "sub/secret"), root),
      ).rejects.toThrow("outside");
    });
  });
});
