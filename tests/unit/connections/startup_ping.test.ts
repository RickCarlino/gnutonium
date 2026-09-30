import { expect, test } from "bun:test";
import { TYPE } from "../../../src/const";
import { parseHeader } from "../../../src/wire/codec";
import { makeNode, makePeer, MockSocket } from "../../helpers/protocol";

test("each connection's startup timer probes only that peer, including leaves", () => {
  const timers = new Map<NodeJS.Timeout, () => void>();
  const node = makeNode("/tmp/startup-ping-test.json", {
    runtimeConfig: { nodeMode: "ultrapeer", enableQrp: false },
    collaborators: {
      scheduler: {
        setTimeout: (fn, ms) => {
          const timer = {} as NodeJS.Timeout;
          // Advance connection startup work, leaving hourly announcements idle.
          if (ms < 1000) timers.set(timer, fn);
          return timer;
        },
        clearTimeout: (timer) => {
          timers.delete(timer);
        },
      },
    },
  });
  const fixtures = [
    makePeer("mesh"),
    makePeer("leaf"),
    makePeer("dropped"),
  ];
  fixtures[0]!.role = "ultrapeer";
  const attached = fixtures.map((peer) =>
    node.connections.attachPeer(
      peer.socket,
      true,
      peer.remoteLabel,
      peer.role,
      peer.capabilities,
    ),
  );
  attached[2]!.socket.destroy();
  expect(timers.size).toBe(2);
  for (const callback of timers.values()) callback();
  const ids = [];
  for (const peer of fixtures.slice(0, 2)) {
    const writes = (peer.socket as unknown as MockSocket).writes;
    expect(writes).toHaveLength(1);
    const header = parseHeader(writes[0]!);
    expect(header).toMatchObject({
      payloadType: TYPE.PING,
      ttl: 1,
      hops: 0,
    });
    ids.push(header.descriptorIdHex);
  }
  expect(new Set(ids).size).toBe(2);
  expect(
    (fixtures[2]!.socket as unknown as MockSocket).writes,
  ).toHaveLength(0);
  node.router.sendPing(1, attached[2]!);
  expect(
    (fixtures[2]!.socket as unknown as MockSocket).writes,
  ).toHaveLength(0);
  for (const peer of attached) peer.socket.destroy();
});
