import { expect, test } from "bun:test";
import type { PeerConnection } from "../../../src/connections/types";
import { HEADER_LEN, TYPE } from "../../../src/const";
import type { RuntimeConfig } from "../../../src/types";
import {
  buildHeader,
  encodePong,
  parseHeader,
  parsePong,
} from "../../../src/wire/codec";
import { encodeGgep } from "../../../src/wire/ggep";
import { makeNode, makePeer, MockSocket } from "../../helpers/protocol";

function fixture(nodeMode: RuntimeConfig["nodeMode"] = "ultrapeer") {
  let now = 0;
  let nextId = 1;
  const node = makeNode("/tmp/ping-routing-test.json", {
    runtimeConfig: {
      nodeMode,
      enablePongCaching: true,
      maxTtl: 7,
      advertisedHost: "127.0.0.1",
      advertisedPort: 6346,
    },
    collaborators: { clock: { now: () => now } },
  });
  const source = makePeer("source");
  const other = makePeer("other");
  for (const peer of [source, other]) {
    peer.role = "ultrapeer";
    node.connections.peers.set(peer.key, peer);
  }
  const receive = (
    peer: PeerConnection,
    type: number,
    ttl: number,
    hops: number,
    payload: Buffer = Buffer.alloc(0),
    id: number | string = nextId++,
  ) => {
    const guid =
      typeof id === "string"
        ? Buffer.from(id, "hex")
        : Buffer.alloc(16, id);
    peer.buf = buildHeader(guid, type, ttl, hops, payload);
    node.connections.consumePeerBuffer(peer);
    return guid.toString("hex");
  };
  return {
    node,
    source,
    other,
    receive,
    setTime: (value: number) => {
      now = value;
    },
  };
}

function messages(peer: PeerConnection) {
  return (peer.socket as unknown as MockSocket).writes.map((frame) => ({
    ...parseHeader(frame),
    payload: frame.subarray(HEADER_LEN),
  }));
}

function pong(port: number): Buffer {
  return Buffer.concat([
    encodePong(port, "127.0.0.1", 11, 51),
    encodeGgep([{ id: "VC", data: Buffer.from("TEST") }]),
  ]);
}

test.each(["leaf", "ultrapeer"] as const)(
  "%s answers each probe with just its own pong despite a full cache",
  (mode) => {
    const { source, other, receive } = fixture(mode);
    for (let i = 0; i < 12; i++) {
      receive(other, TYPE.PONG, 1, i % 6, pong(6400 + i));
    }
    const direct = receive(source, TYPE.PING, 1, 0);
    const relayed = receive(source, TYPE.PING, 1, 1);
    const replies = messages(source);
    expect(replies).toHaveLength(2);
    expect(
      replies.map(({ descriptorIdHex, ttl, hops }) => ({
        descriptorIdHex,
        ttl,
        hops,
      })),
    ).toEqual([
      { descriptorIdHex: direct, ttl: 1, hops: 0 },
      { descriptorIdHex: relayed, ttl: 2, hops: 0 },
    ]);
    for (const reply of replies) {
      expect(reply.payloadType).toBe(TYPE.PONG);
      expect(parsePong(reply.payload).port).toBe(6346);
    }
    expect(messages(other)).toHaveLength(0);
  },
);

test("cached discovery replies retain distance and GGEP, exclude the source, and respect the reply budget", () => {
  const { source, other, receive } = fixture();
  const cached = Array.from({ length: 12 }, (_, i) => pong(6400 + i));
  for (const payload of cached) receive(other, TYPE.PONG, 1, 2, payload);
  receive(source, TYPE.PONG, 1, 0, pong(6500));
  receive(other, TYPE.PONG, 1, 7, pong(6600));
  const guid = receive(source, TYPE.PING, 3, 1);
  const replies = messages(source);
  expect(replies).toHaveLength(10);
  expect(replies[0]!.hops).toBe(0);
  expect(parsePong(replies[0]!.payload).port).toBe(6346);
  for (const reply of replies.slice(1)) {
    expect(reply.payloadType).toBe(TYPE.PONG);
    expect(reply.descriptorIdHex).toBe(guid);
    expect(reply.ttl).toBe(2);
    expect(reply.hops).toBe(3);
    expect(cached.some((payload) => payload.equals(reply.payload))).toBe(
      true,
    );
  }
});

test("leaf nodes neither redistribute cached pongs nor relay return traffic", () => {
  const { node, source, other, receive } = fixture("leaf");
  receive(other, TYPE.PONG, 1, 2, pong(6400));
  const guid = receive(source, TYPE.PING, 3, 0);
  expect(messages(source)).toHaveLength(1);
  expect(messages(other)).toHaveLength(0);
  expect(node.router.pingRoutes.has(guid)).toBe(true);
  receive(other, TYPE.PONG, 2, 0, pong(6500), guid);
  expect(messages(source)).toHaveLength(1);
});

test("discovery throttling covers replies and forwarding without blocking keepalives or other peers", () => {
  const { source, other, receive, setTime } = fixture();
  receive(source, TYPE.PING, 3, 0);
  expect(messages(source)).toHaveLength(1);
  expect(messages(other)).toHaveLength(1);
  setTime(500);
  receive(source, TYPE.PING, 3, 0);
  expect(messages(source)).toHaveLength(1);
  expect(messages(other)).toHaveLength(1);
  receive(source, TYPE.PING, 1, 0);
  expect(messages(source)).toHaveLength(2);
  receive(other, TYPE.PING, 3, 0);
  expect(messages(other)).toHaveLength(2);
  expect(messages(source)).toHaveLength(3);
  setTime(1000);
  receive(source, TYPE.PING, 3, 0);
  expect(messages(source)).toHaveLength(4);
  expect(messages(other)).toHaveLength(3);
});

test("crawler replies cover immediate neighbours, including leaves, with a usable return TTL", () => {
  const { node, source, other, receive } = fixture();
  const leaf = makePeer("leaf");
  node.connections.peers.set(leaf.key, leaf);
  receive(other, TYPE.PONG, 1, 5, pong(6400));
  const guid = receive(source, TYPE.PING, 2, 0);
  expect(messages(source)).toHaveLength(1);
  for (const neighbour of [other, leaf]) {
    expect(messages(neighbour)).toMatchObject([
      { payloadType: TYPE.PING, descriptorIdHex: guid, ttl: 1, hops: 1 },
    ]);
  }
  receive(other, TYPE.PONG, 2, 0, pong(6500), guid);
  receive(leaf, TYPE.PONG, 2, 0, pong(6501), guid);
  expect(messages(source).slice(1)).toMatchObject([
    { payloadType: TYPE.PONG, descriptorIdHex: guid, ttl: 1, hops: 1 },
    { payloadType: TYPE.PONG, descriptorIdHex: guid, ttl: 1, hops: 1 },
  ]);
  expect(
    messages(source).map((reply) => parsePong(reply.payload).port),
  ).toEqual([6346, 6500, 6501]);
});

test("pongs with an exhausted TTL or a return route to their sender are not forwarded", () => {
  const { source, other, receive } = fixture();
  const guid = receive(source, TYPE.PING, 2, 0);
  receive(other, TYPE.PONG, 1, 0, pong(6500), guid);
  receive(source, TYPE.PONG, 2, 0, pong(6501), guid);
  expect(messages(source)).toHaveLength(1);
  expect(messages(other)).toHaveLength(1);
});

test("distinct unsolicited zero-GUID pongs still populate discovery without being forwarded", () => {
  const { node, source, other, receive } = fixture("leaf");
  receive(other, TYPE.PONG, 1, 1, pong(6400), 0);
  receive(other, TYPE.PONG, 1, 4, pong(6401), 0);
  expect(node.router.pongCache.size).toBe(2);
  expect(node.getKnownPeers()).toContain("127.0.0.1:6400");
  expect(node.getKnownPeers()).toContain("127.0.0.1:6401");
  expect(
    [...node.router.pongCache.values()].map((entry) => entry.hops),
  ).toEqual([1, 4]);
  expect(messages(source)).toHaveLength(0);
  expect(messages(other)).toHaveLength(0);
});

test("public peers cannot discover, cache, or relay private or unusable pong endpoints", () => {
  const { node, source, other, receive } = fixture();
  (other.socket as unknown as MockSocket).remoteAddress = "::ffff:8.8.8.8";
  other.capabilities.listenIp = { host: "127.0.0.1", port: 6346 };
  const guid = receive(source, TYPE.PING, 2, 0);
  for (const host of ["192.168.1.1", "127.0.0.2", "0.0.0.0"]) {
    receive(other, TYPE.PONG, 2, 0, encodePong(6567, host, 0, 0), guid);
  }
  receive(other, TYPE.PONG, 2, 0, encodePong(0, "8.8.4.4", 0, 0), guid);
  expect(node.getKnownPeers()).toEqual([]);
  expect(node.router.pongCache.size).toBe(0);
  expect(messages(source)).toHaveLength(1);

  receive(other, TYPE.PONG, 2, 0, encodePong(6346, "8.8.4.4", 0, 0), guid);
  expect(node.getKnownPeers()).toEqual(["8.8.4.4:6346"]);
  expect(node.router.pongCache.size).toBe(1);
  expect(messages(source)).toHaveLength(2);
});
