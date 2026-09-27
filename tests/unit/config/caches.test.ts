import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { KNOWN_CACHES } from "../../../src/gwebcache_client";
import { loadDoc, writeDoc } from "../../../src/protocol";
import { withTempDir } from "../../helpers/protocol";

const seed = "http://seed.example/cache";
const learned = "http://learned.example/cache";

test("legacy seeds and discoveries migrate together without losing rejection or cooldown history", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "gnutella.json");
    const history = {
      [seed]: {
        status: "rejected",
        discoveredAt: 10,
        lastAttemptAt: 20,
        nextAllowedAt: 3620,
        reason: "unsupported network",
      },
      [learned]: {
        status: "verified",
        discoveredAt: 11,
        lastAttemptAt: 21,
        lastSuccessAt: 22,
        nextAllowedAt: 3622,
      },
    };
    await fs.writeFile(
      file,
      JSON.stringify({
        config: {
          data_dir: dir,
          gwebcache_urls: [seed, "http://untested.example/"],
        },
        state: {
          gwebcaches: history,
          gwebcache_next_request_at: 3621,
          peers: {},
        },
      }),
    );
    const doc = await loadDoc(file);
    const entries = doc.config.gwebCaches!.entries;
    expect(entries[seed]).toMatchObject({
      ...history[seed],
    });
    expect(entries[learned]).toMatchObject({
      ...history[learned],
    });
    expect(entries["http://untested.example/"]).toMatchObject({
      status: "candidate",
    });
    expect(doc.config.gwebCaches).not.toHaveProperty("nextRequestAt");
    const migrated = JSON.parse(await fs.readFile(file, "utf8"));
    expect(migrated.config.gwebcache_urls).toBeUndefined();
    expect(migrated.state.gwebcaches).toBeUndefined();
    expect(Object.keys(migrated.config.gwebcaches)).toHaveLength(3);
    await writeDoc(file, await loadDoc(file));
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(migrated);
  });
});

test("current objects are authoritative, and deleting a cache does not resurrect a seed", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "gnutella.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        config: {
          data_dir: dir,
          gwebcaches: {
            [learned]: {
              status: "candidate",
              discoveredAt: 42,
            },
          },
          gwebcache_urls: [seed],
        },
        state: {
          peers: {},
          gwebcaches: { [seed]: { status: "verified" } },
        },
      }),
    );
    const doc = await loadDoc(file);
    expect(Object.keys(doc.config.gwebCaches!.entries)).toEqual([learned]);
    expect(doc.config.gwebCaches!.entries[learned].status).toBe(
      "candidate",
    );
    expect(
      Object.keys((await loadDoc(file)).config.gwebCaches!.entries),
    ).toEqual([learned]);
  });
});

test("an empty object collection is seeded and written immediately", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "gnutella.json");
    await fs.writeFile(
      file,
      JSON.stringify({ config: { data_dir: dir, gwebcaches: {} } }),
    );
    const doc = await loadDoc(file);
    expect(Object.keys(doc.config.gwebCaches!.entries)).toEqual([
      ...KNOWN_CACHES,
    ]);
    expect(
      Object.values(doc.config.gwebCaches!.entries).every(
        (entry) => entry.status === "candidate",
      ),
    ).toBe(true);
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    expect(Object.keys(saved.config.gwebcaches)).toEqual([
      ...KNOWN_CACHES,
    ]);
    expect(saved.state.gwebcaches).toBeUndefined();
  });
});

test("obsolete source attributes are removed on load without changing cache history", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "gnutella.json");
    const record = {
      status: "verified",
      discoveredAt: 10,
      lastAttemptAt: 20,
      lastSuccessAt: 21,
      nextAllowedAt: 3621,
    };
    await fs.writeFile(
      file,
      JSON.stringify({
        config: {
          data_dir: dir,
          gwebcaches: { [seed]: { ...record, source: "user" } },
        },
        state: { gwebcache_next_request_at: 3620 },
      }),
    );
    const doc = await loadDoc(file);
    expect(doc.config.gwebCaches!.entries[seed]).not.toHaveProperty(
      "source",
    );
    expect(doc.config.gwebCaches!.entries[seed]).toMatchObject(record);
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    expect(saved.config.gwebcaches[seed]).toEqual(record);
    expect(saved.state.gwebcache_next_request_at).toBeUndefined();
  });
});

test.each([
  "results.sort is not a function. (In 'results.sort((a, b) => b.family - a.family)', 'results.sort' is undefined)",
  "invalid spec2 gwebcache response",
])(
  "old ambiguous or local failures recover without losing cooldowns: %s",
  async (reason) => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "gnutella.json");
      const timing = {
        discoveredAt: 0,
        lastAttemptAt: 1790537411,
        nextAllowedAt: 1790541011,
      };
      await fs.writeFile(
        file,
        JSON.stringify({
          config: {
            data_dir: dir,
            gwebcaches: {
              [seed]: {
                ...timing,
                status: "rejected",
                reason,
              },
              [learned]: {
                ...timing,
                status: "rejected",
                reason: "unsupported network",
              },
            },
          },
          state: { gwebcache_next_request_at: timing.nextAllowedAt },
        }),
      );
      const doc = await loadDoc(file);
      expect(doc.config.gwebCaches!.entries[seed]).toMatchObject({
        ...timing,
        status: "candidate",
      });
      expect(doc.config.gwebCaches!.entries[seed].reason).toBeUndefined();
      expect(doc.config.gwebCaches!.entries[learned].status).toBe(
        "rejected",
      );
      expect(doc.config.gwebCaches).not.toHaveProperty("nextRequestAt");
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      expect(saved.config.gwebcaches[seed]).toEqual({
        ...timing,
        status: "candidate",
      });
      expect(saved.config.gwebcaches[learned].reason).toBe(
        "unsupported network",
      );
    });
  },
);
