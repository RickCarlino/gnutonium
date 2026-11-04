import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  defaultDoc,
  loadDoc,
  runtimeConfigFor,
} from "../../../src/config/document";
import { withTempDir } from "../../helpers/protocol";

test.each([false, true])(
  "connection defaults follow ultrapeer=%s when runtime limits are omitted",
  (ultrapeer) => {
    const configPath = "/tmp/connection-defaults/config.json";
    const doc = defaultDoc(configPath);
    doc.config.ultrapeer = ultrapeer;
    delete doc.config.maxUltrapeerConnections;
    delete doc.config.maxLeafConnections;

    const runtime = runtimeConfigFor(configPath, doc);
    expect(runtime.maxUltrapeerConnections).toBe(ultrapeer ? 40 : 3);
    expect(runtime.maxLeafConnections).toBe(100);
    expect(runtime.maxConnections).toBe(ultrapeer ? 140 : 3);
    expect(runtime.enableCompression).toBe(true);
  },
);

test.each([
  { ultrapeer: false, defaultUltrapeers: 3 },
  { ultrapeer: true, defaultUltrapeers: 40 },
])(
  "loading $ultrapeer resolves defaults and preserves explicit limits",
  async ({ ultrapeer, defaultUltrapeers }) => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "config.json");
      for (const explicit of [false, true]) {
        await fs.writeFile(
          configPath,
          JSON.stringify({
            config: {
              ultrapeer,
              ...(explicit
                ? {
                    max_ultrapeer_connections: 64,
                    max_leaf_connections: 64,
                  }
                : {}),
            },
          }),
        );
        const doc = await loadDoc(configPath, { readOnly: true });
        const runtime = runtimeConfigFor(configPath, doc);
        const expectedUltrapeers = explicit ? 64 : defaultUltrapeers;
        const expectedLeaves = explicit ? 64 : 100;
        expect(doc.config.maxUltrapeerConnections).toBe(
          expectedUltrapeers,
        );
        expect(runtime.maxUltrapeerConnections).toBe(expectedUltrapeers);
        expect(runtime.maxLeafConnections).toBe(expectedLeaves);
        expect(runtime.maxConnections).toBe(
          ultrapeer
            ? expectedUltrapeers + expectedLeaves
            : expectedUltrapeers,
        );
      }
    });
  },
);
