import { describe, expect, test } from "bun:test";
import { LOCAL_ROUTE, TYPE } from "../../../../src/const";
import {
  forwardedDescriptorLifetime,
  normalizeQueryLifetime,
  overflowPongCacheKeys,
  pongCacheKey,
  pongReplyTtl,
  queryHitReplyTtl,
  responseRouteDecision,
  selectCachedPongs,
  shouldMarkDescriptorSeen,
  shouldSuppressDescriptor,
} from "../../../../src/routing/descriptors";

describe("descriptor routing", () => {
  test("normalizes descriptor lifetimes", () => {
    expect(normalizeQueryLifetime(7, 2, 4)).toEqual({
      ttl: 2,
      hops: 2,
    });
    expect(normalizeQueryLifetime(16, 0, 7)).toBeNull();
    expect(normalizeQueryLifetime(1, 8, 7)).toBeNull();
    expect(forwardedDescriptorLifetime(2, 3)).toEqual({
      ttl: 1,
      hops: 4,
    });
    expect(forwardedDescriptorLifetime(0, 3)).toBeUndefined();
    expect(pongReplyTtl(0)).toBe(1);
    expect(pongReplyTtl(4)).toBe(5);
    expect(queryHitReplyTtl(4, 7)).toBe(6);
    expect(queryHitReplyTtl(9, 7)).toBe(7);
  });

  test("suppresses duplicates and non-response descriptors after Bye", () => {
    expect(
      shouldSuppressDescriptor({
        closingAfterBye: true,
        payloadType: TYPE.PING,
        alreadySeen: false,
      }),
    ).toBe(true);
    expect(
      shouldSuppressDescriptor({
        closingAfterBye: true,
        payloadType: TYPE.QUERY_HIT,
        alreadySeen: false,
      }),
    ).toBe(false);
    expect(
      shouldSuppressDescriptor({
        closingAfterBye: false,
        payloadType: TYPE.PING,
        alreadySeen: true,
      }),
    ).toBe(true);
    expect(
      shouldSuppressDescriptor({
        closingAfterBye: false,
        payloadType: TYPE.ROUTE_TABLE_UPDATE,
        alreadySeen: true,
      }),
    ).toBe(false);
    expect(shouldMarkDescriptorSeen(TYPE.ROUTE_TABLE_UPDATE)).toBe(false);
    expect(shouldMarkDescriptorSeen(TYPE.PING)).toBe(true);
  });

  test("decides response route actions", () => {
    const route = { peerKey: "p1", ts: 123 };

    expect(responseRouteDecision(undefined)).toEqual({ kind: "drop" });
    expect(responseRouteDecision(LOCAL_ROUTE)).toEqual({ kind: "local" });
    expect(responseRouteDecision(route)).toEqual({
      kind: "forward",
      route,
    });
    expect(responseRouteDecision(route, { nodeMode: "leaf" })).toEqual({
      kind: "drop",
    });
    expect(
      responseRouteDecision(route, {
        nodeMode: "leaf",
        forwardInLeaf: true,
      }),
    ).toEqual({ kind: "forward", route });
  });

  test("keys, trims, and selects cached pongs", () => {
    const oldest = Buffer.from("oldest");
    const newer = Buffer.from("newer");
    const newest = Buffer.from("newest");
    const entries = new Map([
      [
        "oldest",
        { payload: oldest, at: 1, hops: 0, sourcePeerKey: "source" },
      ],
      [
        "newer",
        { payload: newer, at: 2, hops: 2, sourcePeerKey: "source" },
      ],
      [
        "newest",
        { payload: newest, at: 3, hops: 5, sourcePeerKey: "source" },
      ],
    ]);

    expect(pongCacheKey(Buffer.from("alpha"))).toMatch(/^[0-9a-f]{40}$/);
    expect(overflowPongCacheKeys(entries.entries(), 2)).toEqual([
      "oldest",
    ]);
    expect(
      selectCachedPongs(entries.values(), 1, 3, "recipient", 7).map(
        (entry) => entry.payload.toString("utf8"),
      ),
    ).toEqual(["newest", "newer"]);
    expect(
      selectCachedPongs(entries.values(), 3, 3, "recipient", 7),
    ).toEqual([]);
  });
});
