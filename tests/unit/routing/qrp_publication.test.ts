import { expect, test } from "bun:test";
import { QrpTable } from "../../../src/routing/qrp";
import { QrpPublisher } from "../../../src/routing/qrp_publication";
import { parseRouteTableUpdate } from "../../../src/wire/codec";
import { makePeer } from "../../helpers/protocol";

function fixture(
  options: {
    sleep?: () => Promise<void>;
    beforeSend?: (payload: Buffer) => void;
  } = {},
) {
  let table: QrpTable | undefined = new QrpTable();
  const sent: Buffer[] = [];
  const publisher = new QrpPublisher({
    tableForPeer: () => table,
    maxPayloadBytes: () => 256,
    send: (_peer, payload) => {
      options.beforeSend?.(payload);
      sent.push(payload);
    },
    sleep: options.sleep ?? (async () => {}),
  });
  return {
    publisher,
    sent,
    table,
    setTable: (next: QrpTable | undefined) => {
      table = next;
    },
  };
}

test("advertises empty tables once per connection, including concurrent requests", async () => {
  const { publisher, sent, table } = fixture();
  const peer = makePeer();
  await Promise.all([publisher.send(peer), publisher.send(peer)]);
  expect(
    sent.map((payload) => parseRouteTableUpdate(payload).variant),
  ).toEqual(["reset", "patch"]);
  table.rebuildFromShares([]);
  await publisher.send(peer);
  expect(sent).toHaveLength(2);
  await publisher.send(makePeer(peer.key));
  expect(sent).toHaveLength(4);
});

test("publishes additions, removals, and table metadata changes but skips equivalent rebuilds", async () => {
  const { publisher, sent, table, setTable } = fixture();
  const peer = makePeer();
  await publisher.send(peer);
  table.rebuildFromShares([{ keywords: ["alpha"] }]);
  await publisher.send(peer);
  expect(sent).toHaveLength(4);
  table.rebuildFromShares([{ keywords: ["alpha"] }]);
  await publisher.send(peer);
  expect(sent).toHaveLength(4);
  table.clear();
  await publisher.send(peer);
  expect(sent).toHaveLength(6);
  setTable(new QrpTable(8));
  await publisher.send(peer);
  setTable(new QrpTable(8, 2));
  await publisher.send(peer);
  expect(sent).toHaveLength(10);
});

test("an ineligible publication does not suppress the first eligible advertisement", async () => {
  const { publisher, sent, table, setTable } = fixture();
  const peer = makePeer();
  setTable(undefined);
  await publisher.send(peer);
  expect(sent).toHaveLength(0);
  setTable(table);
  await publisher.send(peer);
  expect(sent).toHaveLength(2);
});

test("retries after a partial failure even when reverting to the previously sent table", async () => {
  let fail = false;
  const { publisher, sent, table } = fixture({
    beforeSend: (payload) => {
      if (fail && payload[0] === 1) throw new Error("write failed");
    },
  });
  const peer = makePeer();
  await publisher.send(peer);
  table.rebuildFromShares([{ keywords: ["alpha"] }]);
  fail = true;
  await expect(publisher.send(peer)).rejects.toThrow("write failed");
  fail = false;
  table.clear();
  await publisher.send(peer);
  expect(sent.map((payload) => payload[0])).toEqual([0, 1, 0, 0, 1]);
});

test("serializes multi-chunk updates and snapshots tables before a concurrent rebuild", async () => {
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let firstSleep = true;
  const { publisher, sent, setTable } = fixture({
    sleep: async () => {
      if (!firstSleep) return;
      firstSleep = false;
      paused.resolve();
      await resume.promise;
    },
  });
  const table = new QrpTable(8192);
  let seed = 123;
  for (let i = 0; i < table.tableSize; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    if (seed & 0x80000000) table.table[i] = 1;
  }
  setTable(table);
  const expected = table.encodePatchChunks(256, 4);
  expect(expected.length).toBeGreaterThan(1);
  const peer = makePeer();
  const first = publisher.send(peer);
  await paused.promise;
  table.clear();
  const second = publisher.send(peer);
  const duplicate = publisher.send(peer);
  expect(sent).toHaveLength(2);
  resume.resolve();
  await Promise.all([first, second, duplicate]);
  expect(sent.slice(1, 1 + expected.length)).toEqual(expected);
  expect(sent.slice(1 + expected.length)).toEqual([
    table.encodeReset(),
    ...table.encodePatchChunks(256, 4),
  ]);
});

test("dropping a connection cancels queued updates and disposal forgets advertisements", async () => {
  const { publisher, sent } = fixture();
  const peer = makePeer();
  const queued = publisher.send(peer);
  publisher.drop(peer);
  await queued;
  expect(sent).toHaveLength(0);
  await publisher.send(peer);
  expect(sent).toHaveLength(2);
  publisher.dispose();
  await publisher.send(peer);
  expect(sent).toHaveLength(4);
});
