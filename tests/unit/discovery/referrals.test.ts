import { expect, test } from "bun:test";
import { isAllowedPeerReferral } from "../../../src/discovery/addresses";
import { makeNode, makePeer, MockSocket } from "../../helpers/protocol";

const nonPublicHosts = [
  "0.0.0.0",
  "10.0.0.1",
  "127.0.0.2",
  "100.64.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.1.1",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "255.255.255.255",
];

test.each(nonPublicHosts)(
  "public and unidentified sources cannot refer %s",
  (host) => {
    for (const reporter of ["8.8.8.8", "::ffff:8.8.8.8", undefined]) {
      expect(isAllowedPeerReferral(host, reporter)).toBe(false);
    }
  },
);

test("local referrals preserve LAN and loopback use without trusting invalid sources", () => {
  expect(isAllowedPeerReferral("192.168.1.2", "10.0.0.1")).toBe(true);
  expect(isAllowedPeerReferral("10.0.0.2", "::ffff:192.168.1.1")).toBe(
    true,
  );
  expect(isAllowedPeerReferral("127.0.0.2", "127.0.0.1")).toBe(true);
  expect(isAllowedPeerReferral("192.168.1.2", "127.0.0.1")).toBe(true);
  expect(isAllowedPeerReferral("127.0.0.2", "192.168.1.1")).toBe(false);
  expect(isAllowedPeerReferral("192.168.1.2", "invalid")).toBe(false);
  expect(isAllowedPeerReferral("192.168.1.2", "0.0.0.0")).toBe(false);
  expect(isAllowedPeerReferral("224.0.0.1", "127.0.0.1")).toBe(false);
  expect(isAllowedPeerReferral("8.8.4.4")).toBe(true);
  expect(isAllowedPeerReferral("8.8.4.4", "192.168.1.1")).toBe(true);
});

test("both referral headers use the socket reporter, not claimed addresses", () => {
  const node = makeNode("/tmp/peer-referrals-test.json");
  node.connections.absorbHandshakeHeaders(
    {
      "x-try": "127.0.0.2:6346,8.8.4.4:6346",
      "x-try-ultrapeers": "192.168.1.1:6567,1.1.1.1:6346",
      "remote-ip": "127.0.0.1",
      "listen-ip": "127.0.0.1:6346",
    },
    "::ffff:8.8.8.8",
  );
  expect(node.getKnownPeers().sort()).toEqual([
    "1.1.1.1:6346",
    "8.8.4.4:6346",
  ]);
});

test("private Listen-IP is not remembered on attach or after a stable public connection", () => {
  const node = makeNode("/tmp/peer-referrals-test.json");
  const peer = makePeer("8.8.8.8:6346");
  (peer.socket as unknown as MockSocket).remoteAddress = "::ffff:8.8.8.8";
  peer.outbound = true;
  peer.dialTarget = "8.8.8.8:6346";
  peer.capabilities.listenIp = { host: "192.168.1.1", port: 6567 };
  node.discovery.rememberPeerAddresses(peer);
  node.discovery.markPeerSeenIfStable(peer, peer.connectedAt + 61_000);
  expect(node.getKnownPeers()).toEqual(["8.8.8.8:6346"]);
  expect(node.discovery.knownPeers[peer.dialTarget]).toBeGreaterThan(0);
});

test("explicit LAN endpoints and local Listen-IP remain discoverable", () => {
  const node = makeNode("/tmp/peer-referrals-test.json");
  node.discovery.addKnownPeer("192.168.1.1", 6567);
  const peer = makePeer("192.168.1.2:6346");
  (peer.socket as unknown as MockSocket).remoteAddress = "192.168.1.2";
  peer.dialTarget = "192.168.1.2:6346";
  peer.capabilities.listenIp = { host: "10.0.0.2", port: 6346 };
  node.discovery.rememberPeerAddresses(peer);
  expect(node.getKnownPeers().sort()).toEqual([
    "10.0.0.2:6346",
    "192.168.1.1:6567",
    "192.168.1.2:6346",
  ]);
});
