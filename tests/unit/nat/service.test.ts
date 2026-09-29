import { expect, test } from "bun:test";
import type { NatGateway, PortMapping } from "../../../src/nat/gateway";
import { NatService, type NatStatus } from "../../../src/nat/service";
import { SoapError } from "../../../src/nat/soap";
import type { PeerAddr } from "../../../src/types";

const config = { listenHost: "0.0.0.0", listenPort: 6346 };

function fixture() {
  let entry: PortMapping | undefined;
  let endpoint: PeerAddr | undefined;
  let next: (() => void) | undefined;
  let scheduled: (() => void) | undefined;
  let delay = 0;
  let discoveries = 0;
  let permanentOnly = false;
  let failure = false;
  const adds: number[] = [];
  const removals: number[] = [];
  const events: NatStatus[] = [];
  const gateway: NatGateway = {
    localAddress: "192.168.1.2",
    externalAddress: async () => "44.55.66.77",
    lookup: async () => entry,
    add: async (port, description, lease) => {
      adds.push(lease);
      if (failure) throw new Error("Router offline");
      if (permanentOnly && lease) throw new SoapError("725");
      entry = { client: gateway.localAddress, port, description };
    },
    remove: async (port) => {
      removals.push(port);
      entry = undefined;
    },
  };
  const service = new NatService({
    discover: async () => {
      discoveries++;
      return [gateway];
    },
    scheduler: {
      setTimeout: (fn, ms) => {
        next = fn;
        delay = ms;
        scheduled?.();
        return setTimeout(() => {}, 0);
      },
      clearTimeout: (timer) => {
        next = undefined;
        clearTimeout(timer);
      },
    },
    address: (value) => {
      endpoint = value;
    },
    report: (status) => events.push(status),
  });
  return {
    service,
    gateway,
    adds,
    removals,
    events,
    endpoint: () => endpoint,
    delay: () => delay,
    discoveries: () => discoveries,
    setEntry: (value: PortMapping) => {
      entry = value;
    },
    setPermanent: () => {
      permanentOnly = true;
    },
    fail: () => {
      failure = true;
    },
    cycle: () =>
      new Promise<void>((resolve) => {
        scheduled = resolve;
        next!();
      }),
  };
}

test("automatic mapping advertises, renews and removes only its owned TCP mapping", async () => {
  const f = fixture();
  await f.service.start(config);
  expect(f.endpoint()).toEqual({ host: "44.55.66.77", port: 6346 });
  expect(f.delay()).toBe(1_200_000);
  await f.cycle();
  expect(f.adds).toEqual([3600, 3600]);
  expect(f.discoveries()).toBe(1);
  expect(f.events).toHaveLength(1);
  await f.service.stop();
  expect(f.removals).toEqual([6346]);
  expect(f.endpoint()).toBeUndefined();
});

test("legacy permanent leases retry with zero and are cleaned up", async () => {
  const f = fixture();
  f.setPermanent();
  await f.service.start(config);
  await f.cycle();
  expect(f.adds).toEqual([3600, 0, 0]);
  await f.service.stop();
  expect(f.removals).toEqual([6346]);
});

test("existing mappings are neither overwritten nor deleted", async () => {
  const f = fixture();
  f.setEntry({
    client: "192.168.1.2",
    port: 6346,
    description: "Another app",
  });
  await f.service.start(config);
  expect(f.endpoint()).toBeUndefined();
  expect(f.adds).toEqual([]);
  expect(f.delay()).toBe(60_000);
  await f.service.stop();
  expect(f.removals).toEqual([]);
});

test("a mapping replaced by someone else is not removed on shutdown", async () => {
  const f = fixture();
  await f.service.start(config);
  f.setEntry({
    client: "192.168.1.3",
    port: 6346,
    description: "Replacement",
  });
  await f.service.stop();
  expect(f.removals).toEqual([]);
});

test("renewal failure clears the advertised endpoint and retries discovery", async () => {
  const f = fixture();
  await f.service.start(config);
  f.fail();
  await f.cycle();
  expect(f.endpoint()).toBeUndefined();
  expect(f.events.at(-1)?.state).toBe("unavailable");
  expect(f.delay()).toBe(60_000);
  await f.cycle();
  expect(f.discoveries()).toBe(2);
  await f.service.stop();
});

test("manual endpoints and loopback listeners do not perform discovery", async () => {
  for (const overrides of [
    { listenHost: "127.0.0.1" },
    { advertisedHost: "44.55.66.77" },
    { advertisedPort: 7000 },
  ]) {
    const f = fixture();
    await f.service.start({ ...config, ...overrides });
    expect(f.discoveries()).toBe(0);
    expect(f.events[0].state).toBe("skipped");
    await f.service.stop();
  }
});

test("shutdown waits for an in-flight successful add and immediately removes it", async () => {
  const f = fixture();
  const original = f.gateway.add;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.gateway.add = async (...args) => {
    entered.resolve();
    await release.promise;
    await original(...args);
  };
  const starting = f.service.start(config);
  await entered.promise;
  const stopping = f.service.stop();
  release.resolve();
  await Promise.all([starting, stopping]);
  expect(f.removals).toEqual([6346]);
  expect(f.endpoint()).toBeUndefined();
  expect(f.events).toEqual([]);
});

test("discovery aborts on shutdown and no mapping is attempted afterwards", async () => {
  let attempted = false;
  const service = new NatService({
    discover: (_host, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), {
          once: true,
        });
      }),
    scheduler: { setTimeout, clearTimeout },
    address: () => {},
    report: () => {
      attempted = true;
    },
  });
  const starting = service.start(config);
  await service.stop();
  await starting;
  expect(attempted).toBe(false);
});
