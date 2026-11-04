import type net from "node:net";
import { isAllowedPeerReferral } from "../discovery/addresses";
import { errMsg, toBuffer, ts } from "../shared";
import type { parsePush } from "../wire/codec";
import { boundedHttpHeaderEnd } from "../wire/http";
import type { TransferService } from "./service";

type PushRequest = ReturnType<typeof parsePush>;

function allowedPush(
  transfers: TransferService,
  push: PushRequest,
  reporterHost: string | undefined,
): boolean {
  return (
    Number.isInteger(push.port) &&
    push.port > 0 &&
    push.port <= 65535 &&
    isAllowedPeerReferral(push.ip, reporterHost) &&
    !transfers.config().blockedIps.includes(push.ip) &&
    !transfers.deps.address.isSelfPeer(push.ip, push.port)
  );
}

/** Offer a share to an allowed callback address, with bounded negotiation. */
export async function fulfillPush(
  transfers: TransferService,
  push: PushRequest,
  reporterHost?: string,
): Promise<void> {
  if (!allowedPush(transfers, push, reporterHost)) return;
  const share = transfers.deps.shares.byIndex(push.fileIndex);
  if (!share) return;
  transfers.deps.emit({
    type: "PUSH_REQUESTED",
    at: ts(),
    fileIndex: share.index,
    fileName: share.name,
    ip: push.ip,
    port: push.port,
  });
  let socket: net.Socket;
  try {
    socket = transfers.createConnection({
      host: push.ip,
      port: push.port,
    });
  } catch (error) {
    reportFailure(transfers, error);
    return;
  }
  let buf = Buffer.alloc(0);
  const cleanup = () => {
    if (deadline) transfers.deps.scheduler.clearTimeout(deadline);
    socket.off("connect", onConnect);
    socket.off("data", onData);
    socket.off("close", cleanup);
    socket.off("error", onError);
  };
  const onError = (error: unknown) => {
    cleanup();
    reportFailure(transfers, error);
    socket.destroy();
  };
  const onConnect = () => {
    socket.write(
      `GIV ${share.index}:${transfers.deps.serventId.toString("hex")}/${share.name}\n\n`,
    );
  };
  const onData = (chunk: string | Buffer) => {
    try {
      buf = Buffer.concat([buf, toBuffer(chunk)]);
      const raw = buf.toString("latin1");
      const cut = boundedHttpHeaderEnd(raw);
      if (cut === -1) return;
      cleanup();
      transfers.startHttpSession(
        socket,
        raw.slice(0, cut),
        buf.subarray(cut),
      );
    } catch (error) {
      onError(error);
    }
  };
  socket.setNoDelay(true);
  // Keep the upload's idle timeout after the absolute header deadline is released.
  socket.setTimeout(transfers.config().downloadTimeoutMs, () =>
    socket.destroy(),
  );
  socket.once("connect", onConnect);
  socket.on("data", onData);
  socket.once("close", cleanup);
  socket.once("error", onError);
  const deadline = transfers.deps.scheduler.setTimeout(
    () => onError(new Error("push request timeout")),
    transfers.config().downloadTimeoutMs,
  );
}

function reportFailure(transfers: TransferService, error: unknown): void {
  transfers.deps.emit({
    type: "PUSH_CALLBACK_FAILED",
    at: ts(),
    message: errMsg(error),
  });
}
