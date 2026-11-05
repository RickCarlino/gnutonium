import { describe, expect, test } from "bun:test";
import { notifyOfUpdate } from "../../../src/cli/updates";
import { DEFAULT_USER_AGENT } from "../../../src/const";

const UPDATE_MESSAGE =
  "A new version of Gnutonium is available: https://github.com/gnutonium/Gnutonium/releases/latest";

function release(tag: unknown, extra = {}): Response {
  return Response.json({
    tag_name: tag,
    draft: false,
    prerelease: false,
    ...extra,
  });
}

describe("startup update notice", () => {
  test("announces newer major/minor versions using numeric comparison", async () => {
    for (const tag of ["v2.2.0", "2.10.0", "v3.0.0", "3.1.4+build.1"]) {
      const logs: string[] = [];
      await notifyOfUpdate((message) => logs.push(message), {
        currentVersion: "2.1.3",
        fetchImpl: async (url, init) => {
          expect(url).toBe(
            "https://api.github.com/repos/gnutonium/Gnutonium/releases/latest",
          );
          expect(init.headers).toEqual({
            Accept: "application/vnd.github+json",
            "User-Agent": DEFAULT_USER_AGENT,
          });
          expect(init.signal).toBeInstanceOf(AbortSignal);
          return release(tag);
        },
      });
      expect(logs).toEqual([UPDATE_MESSAGE]);
    }
  });

  test("ignores patch updates, current and older releases, and invalid tags", async () => {
    for (const tag of [
      "2.1.4",
      "v2.1.99",
      "2.1.3",
      "v2.1.2",
      "2.0.99",
      "1.99.99",
      "v2.2.0-beta.1",
      "v3.0.0-rc.1",
      "v02.2.0",
      "2.2",
      "2.2.0\n",
      "latest",
      "9007199254740992.0.0",
      null,
      42,
    ]) {
      const logs: string[] = [];
      await notifyOfUpdate((message) => logs.push(message), {
        currentVersion: "2.1.3",
        fetchImpl: async () => release(tag),
      });
      expect(logs).toEqual([]);
    }
  });

  test("ignores drafts, prereleases, and malformed release payloads", async () => {
    for (const response of [
      release("3.0.0", { draft: true }),
      release("3.0.0", { prerelease: true }),
      Response.json(null),
      Response.json([]),
      Response.json({ tag_name: "3.0.0" }),
      new Response("invalid json"),
      new Response("rate limited", { status: 403 }),
      new Response("not found", { status: 404 }),
      new Response("rate limited", { status: 429 }),
    ]) {
      const logs: string[] = [];
      await notifyOfUpdate((message) => logs.push(message), {
        fetchImpl: async () => response,
      });
      expect(logs).toEqual([]);
    }
  });

  test("silently handles network failures and request timeouts", async () => {
    const logs: string[] = [];
    await notifyOfUpdate((message) => logs.push(message), {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    let aborted = false;
    await notifyOfUpdate((message) => logs.push(message), {
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
    });
    expect(aborted).toBe(true);
    expect(logs).toEqual([]);
  });

  test("ignores an invalid installed version without making a request", async () => {
    let requested = false;
    await notifyOfUpdate(() => {}, {
      currentVersion: "invalid",
      fetchImpl: async () => {
        requested = true;
        return release("3.0.0");
      },
    });
    expect(requested).toBe(false);
  });
});
