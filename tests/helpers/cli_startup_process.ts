import { main } from "../../src/cli";
import { notifyOfUpdate } from "../../src/cli/updates";
import { errMsg } from "../../src/shared";

// Exercise the real CLI lifecycle with a deterministic, offline release lookup.
void main(process.argv.slice(2), (log) =>
  notifyOfUpdate(log, {
    fetchImpl: async (_url, init) => {
      const tag = process.env.GNUTONIUM_TEST_RELEASE;
      if (tag === "pending") {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        });
      }
      await Bun.sleep(150);
      if (tag === "offline") throw new Error("offline");
      return Response.json({
        tag_name: tag,
        draft: false,
        prerelease: false,
      });
    },
  }),
).catch((error: unknown) => {
  console.error(errMsg(error));
  process.exit(1);
});
