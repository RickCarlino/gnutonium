import { expect, test } from "bun:test";
import { defaultDoc } from "../../../src/config/document";
import { RuntimeConfiguration } from "../../../src/config/runtime";
import type { PeerConnection } from "../../../src/connections/types";
import { LOCAL_ROUTE, TYPE } from "../../../src/const";
import { QrpTable } from "../../../src/routing/qrp";
import { MessageRouter } from "../../../src/routing/router";
import {
  buildHeader,
  encodeQuery,
  parseHeader,
} from "../../../src/wire/codec";
import { makePeer } from "../../helpers/protocol";

function routerFixture() {
  const file = "/tmp/router-fixture.json";
  const config = new RuntimeConfiguration(file, defaultDoc(file), {
    nodeMode: "ultrapeer",
  });
  const peers = new Map<string, PeerConnection>();
  const sent: Array<{ key: string; type: number; payload: Buffer }> = [];
  const router = new MessageRouter({
    config: () => config.snapshot(),
    now: () => 1234,
    sleep: async () => {},
    emit: () => {},
    serventId: Buffer.alloc(16, 1),
    address: {
      currentAdvertisedHost: () => "127.0.0.1",
      currentAdvertisedPort: () => 6346,
    },
    shares: {
      list: () => [],
      matches: () => [],
      totalSharedKBytes: () => 0,
    },
    search: { ingest: () => {} },
    discoveredPeer: () => {},
    fulfillPush: async () => {},
    transport: {
      peers,
      nodeMode: () => "ultrapeer",
      isLeafPeer: (peer) => peer.role === "leaf",
      isMeshPeer: (peer) => peer.role !== "leaf",
      shouldRelayPings: () => true,
      shouldRelayQueries: () => true,
      peerInfo: (peer) => ({
        key: peer.key,
        remoteLabel: peer.remoteLabel,
        role: peer.role,
        outbound: peer.outbound,
        compression: false,
        tls: false,
      }),
      sendToPeer: (peer, type, _id, _ttl, _hops, payload) =>
        sent.push({ key: peer.key, type, payload }),
    },
  });
  return { router, peers, sent };
}

test("router forwards original query bytes and suppresses duplicate descriptors", () => {
  const { router, peers, sent } = routerFixture();
  const source = makePeer("source");
  const target = makePeer("target");
  source.role = target.role = "ultrapeer";
  peers.set(source.key, source);
  peers.set(target.key, target);
  const payload = encodeQuery("alpha sample");
  const header = parseHeader(
    buildHeader(Buffer.alloc(16, 2), TYPE.QUERY, 3, 0, payload),
  );
  router.handleDescriptor(source, { ...header }, payload);
  router.handleDescriptor(source, { ...header }, payload);
  expect(sent).toEqual([{ key: target.key, type: TYPE.QUERY, payload }]);
  expect(sent[0]?.payload).toBe(payload);
});

test("router releases per-peer QRP state on departure and all routes on disposal", () => {
  const { router } = routerFixture();
  const peer = makePeer();
  router.peerState(peer).lastPingAt = 99;
  router.peerState(peer).qrp.resetSeen = true;
  router.dropPeer(peer);
  expect(router.peerState(peer).lastPingAt).toBeUndefined();
  expect(router.peerState(peer).qrp.resetSeen).toBe(false);
  router.queryRoutes.set("local", LOCAL_ROUTE);
  router.markSeen(TYPE.QUERY, "local");
  router.dispose();
  expect(router.queryRoutes.size).toBe(0);
  expect(router.hasSeen(TYPE.QUERY, "local")).toBe(false);
});

test("an empty ultrapeer republishes only when its aggregate leaf table changes", async () => {
  const { router, peers, sent } = routerFixture();
  const mesh = makePeer("mesh");
  mesh.role = "ultrapeer";
  mesh.capabilities.ultrapeerQueryRoutingVersion = "0.1";
  peers.set(mesh.key, mesh);
  await router.sendQrpTable(mesh);
  expect(sent).toHaveLength(2);

  const leaf = makePeer("leaf");
  leaf.role = "leaf";
  peers.set(leaf.key, leaf);
  const table = new QrpTable();
  table.rebuildFromShares([{ keywords: ["alpha"] }]);
  const updateLeaf = () => {
    router.onRouteTableUpdate(leaf, table.encodeReset());
    for (const patch of table.encodePatchChunks(60 * 1024, 4)) {
      router.onRouteTableUpdate(leaf, patch);
    }
  };
  updateLeaf();
  await router.sendQrpTable(mesh);
  expect(sent).toHaveLength(4);
  updateLeaf();
  await router.sendQrpTable(mesh);
  expect(sent).toHaveLength(4);

  const remote = makePeer("receiver");
  for (const message of sent.slice(2)) {
    router.onRouteTableUpdate(remote, message.payload);
  }
  expect(
    QrpTable.matchesRemote(router.peerState(remote).qrp, "alpha"),
  ).toBe(true);

  peers.delete(leaf.key);
  router.dropPeer(leaf);
  await router.sendQrpTable(mesh);
  expect(sent).toHaveLength(6);
  for (const message of sent.slice(4)) {
    router.onRouteTableUpdate(remote, message.payload);
  }
  expect(
    QrpTable.matchesRemote(router.peerState(remote).qrp, "alpha"),
  ).toBe(false);
  router.dropPeer(mesh);
  await router.sendQrpTable(mesh);
  expect(sent).toHaveLength(8);
});
