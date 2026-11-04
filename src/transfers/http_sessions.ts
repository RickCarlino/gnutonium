import type net from "node:net";
import { toBuffer } from "../shared";
import { socketCanEnd } from "../transport/socket_utils";
import { boundedHttpHeaderEnd, parseHttpHeaders } from "../wire/http";
import type { PendingTransfer, TransferService } from "./service";
import type { HttpSession, HttpSessionRequest } from "./session_types";

const MAX_HTTP_REQUEST_BODY_BYTES = 256 * 1024;

/** Attach handlers and serve requests on an incoming socket. */
export function startHttpSession(
  transfers: TransferService,
  socket: net.Socket,
  firstHead: string,
  initialBuf: Buffer = Buffer.alloc(0),
): void {
  transfers.trackSocket(socket);
  const session: HttpSession = {
    socket,
    buf: Buffer.concat([Buffer.from(firstHead, "latin1"), initialBuf]),
    drainRequested: false,
    busy: false,
    closed: false,
  };

  const closeSession = () => {
    if (session.closed) return;
    session.closed = true;
    socket.off("data", onData);
    socket.off("close", closeSession);
    socket.off("end", closeSession);
    socket.off("error", onError);
  };

  const onData = (chunk: string | Buffer) => {
    if (session.closed) return;
    session.buf = Buffer.concat([session.buf, toBuffer(chunk)]);
    void transfers.drainHttpSession(session, closeSession);
  };

  const onError = () => closeSession();

  socket.on("data", onData);
  socket.on("close", closeSession);
  socket.on("end", closeSession);
  socket.on("error", onError);

  void transfers.drainHttpSession(session, closeSession);
}

/** Find the end of the next buffered HTTP header. */
export function pendingHttpSessionHeadEnd(
  _transfers: TransferService,
  session: HttpSession,
): number {
  return boundedHttpHeaderEnd(session.buf.toString("latin1"));
}

/** Remove and return a complete buffered HTTP header. */
export function shiftHttpSessionHead(
  transfers: TransferService,
  session: HttpSession,
): string | undefined {
  const cut = transfers.pendingHttpSessionHeadEnd(session);
  if (cut === -1) return undefined;
  const raw = session.buf.toString("latin1");
  const head = raw.slice(0, cut);
  session.buf = session.buf.subarray(cut);
  return head;
}

function httpRequestContentLength(head: string): number {
  const raw = parseHttpHeaders(head)["content-length"];
  if (!raw) return 0;
  const length = Number(raw);
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("invalid http content-length");
  }
  if (length > MAX_HTTP_REQUEST_BODY_BYTES) {
    throw new Error("http request body too large");
  }
  return length;
}

/** Remove and return a complete buffered HTTP request. */
export function shiftHttpSessionRequest(
  transfers: TransferService,
  session: HttpSession,
): HttpSessionRequest | undefined {
  const cut = transfers.pendingHttpSessionHeadEnd(session);
  if (cut === -1) return undefined;
  const raw = session.buf.toString("latin1");
  const head = raw.slice(0, cut);
  const contentLength = httpRequestContentLength(head);
  if (session.buf.length < cut + contentLength) return undefined;
  const body = Buffer.from(session.buf.subarray(cut, cut + contentLength));
  session.buf = session.buf.subarray(cut + contentLength);
  return { head, body };
}

/** Serve buffered requests in order while reusable. */
export async function processHttpSessionRequests(
  transfers: TransferService,
  session: HttpSession,
  closeSession: () => void,
): Promise<void> {
  while (!session.closed) {
    const queued = transfers.shiftHttpSessionRequest(session);
    if (!queued) return;
    const keepAlive = await transfers.handleIncomingGet(
      session.socket,
      queued.head,
      queued.body,
    );
    if (keepAlive) continue;
    closeSession();
    if (socketCanEnd(session.socket)) session.socket.end();
    return;
  }
}

/** Process pending requests without overlapping handlers. */
export async function drainHttpSession(
  transfers: TransferService,
  session: HttpSession,
  closeSession: () => void,
): Promise<void> {
  if (session.closed) return;
  // Remember arrivals while a handler (or its promise continuation) is busy.
  session.drainRequested = true;
  if (session.busy) return;
  session.busy = true;
  try {
    do {
      session.drainRequested = false;
      await transfers.processHttpSessionRequests(session, closeSession);
    } while (!session.closed && session.drainRequested);
  } catch {
    closeSession();
    // Cleanup removes the error listener; do not emit an unhandled error.
    session.socket.destroy();
  } finally {
    session.busy = false;
  }
}

/** Queue a waiting download under its remote servent ID. */
export function enqueuePendingPush(
  transfers: TransferService,
  pending: PendingTransfer,
): void {
  const queue = transfers.pendingPushes.get(pending.serventIdHex) || [];
  queue.push(pending);
  transfers.pendingPushes.set(pending.serventIdHex, queue);
}

/** Take the oldest waiting download for a servent. */
export function shiftPendingPush(
  transfers: TransferService,
  serventIdHex: string,
): PendingTransfer | undefined {
  const queue = transfers.pendingPushes.get(serventIdHex);
  if (!queue?.length) return undefined;
  const pending = queue.shift();
  if (queue.length) transfers.pendingPushes.set(serventIdHex, queue);
  else transfers.pendingPushes.delete(serventIdHex);
  return pending;
}

/** Reject and remove expired push callback requests. */
export function prunePendingPushQueues(
  transfers: TransferService,
  now: number,
  waitMs: number,
): void {
  for (const [key, queue] of transfers.pendingPushes) {
    const keep = queue.filter((pending) => {
      if (now - pending.createdAt <= waitMs) return true;
      pending.reject(new Error("push timed out"));
      return false;
    });
    if (keep.length) transfers.pendingPushes.set(key, keep);
    else transfers.pendingPushes.delete(key);
  }
}
