import { expect, test } from "bun:test";
import path from "node:path";
import { CacheAnnouncements } from "../../../src/discovery/gwebcache/announcements";
import { makeNode, makePeer, withTempDir } from "../../helpers/protocol";

const hour = 3_600_000;

function fixture() {
  let now = 0;
  let connected = true;
  let eligible = true;
  let calls = 0;
  let nextAnnouncementAt = 0;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const cancelled: NodeJS.Timeout[] = [];
  const announcements = new CacheAnnouncements({
    now: () => now,
    connected: () => connected,
    eligible: () => eligible,
    nextAnnouncementAt: () => nextAnnouncementAt,
    send: async () => {
      calls++;
    },
    onError: (error) => {
      throw error;
    },
    scheduler: {
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return {} as NodeJS.Timeout;
      },
      clearTimeout: (timer) => {
        cancelled.push(timer);
      },
    },
  });
  return {
    announcements,
    timers,
    cancelled,
    calls: () => calls,
    time: (value: number) => {
      now = value;
    },
    connected: (value: boolean) => {
      connected = value;
      announcements.refresh();
    },
    eligible: (value: boolean) => {
      eligible = value;
    },
    next: (value: number) => {
      nextAnnouncementAt = value;
    },
  };
}

test("announcements recur hourly, and losing all peers restarts the connected-hour requirement", async () => {
  const f = fixture();
  f.announcements.refresh();
  expect(f.timers[0].delay).toBe(hour);
  f.time(hour - 1);
  await f.announcements.announce();
  expect(f.calls()).toBe(0);
  f.time(hour);
  await f.announcements.announce();
  await f.announcements.announce();
  expect(f.calls()).toBe(1);
  f.time(2 * hour);
  await f.announcements.announce();
  expect(f.calls()).toBe(2);
  f.connected(false);
  expect(f.cancelled).toHaveLength(1);
  f.time(3 * hour);
  f.connected(true);
  await f.announcements.announce();
  expect(f.calls()).toBe(2);
  f.time(4 * hour);
  await f.announcements.announce();
  expect(f.calls()).toBe(3);
  f.announcements.dispose();
  f.time(5 * hour);
  await f.announcements.announce();
  expect(f.calls()).toBe(3);
});

test("ineligible nodes and persisted bootstrap cooldowns block announcements", async () => {
  const f = fixture();
  f.eligible(false);
  f.announcements.refresh();
  f.time(hour);
  await f.announcements.announce();
  expect(f.calls()).toBe(0);
  f.eligible(true);
  f.next((3 * hour) / 1000);
  f.time(2 * hour);
  await f.announcements.announce();
  expect(f.calls()).toBe(0);
  f.time(3 * hour);
  await f.announcements.announce();
  expect(f.calls()).toBe(1);
});

test.each([
  [false, false, 0],
  [false, true, 0],
  [true, false, 0],
  [true, true, 1],
] as const)(
  "runtime announcements require ultrapeer=%s and inbound=%s",
  async (ultrapeer, inbound, expected) => {
    await withTempDir(async (dir) => {
      let now = 1_700_000_000_000;
      let calls = 0;
      const node = makeNode(path.join(dir, "config.json"), {
        runtimeConfig: {
          ultrapeer,
          nodeMode: ultrapeer ? "ultrapeer" : "leaf",
          advertisedHost: "44.0.0.1",
          advertisedPort: 6346,
        },
        collaborators: {
          clock: { now: () => now },
          scheduler: {
            setTimeout: () => ({}) as NodeJS.Timeout,
            clearTimeout: () => {},
          },
          bootstrapClient: {
            reportSelfToGWebCaches: async () => {
              calls++;
              return {
                attemptedCaches: [],
                reportedCaches: [],
                errors: [],
              };
            },
          },
        },
      });
      const peer = makePeer("44.0.0.2:6346");
      peer.outbound = !inbound;
      node.connections.peers.set(peer.key, peer);
      node.discovery.rememberPeerAddresses(peer);
      node.discovery.refreshGWebCacheReport();
      now += hour;
      await node.discovery.announceSelfToGWebCaches();
      expect(calls).toBe(expected);
      node.discovery.dispose();
    });
  },
);
