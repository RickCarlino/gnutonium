import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { directDownloadAttempts, type DirectDownloadAttempt } from ".";
import { ensureDir, errMsg, fileExists } from "../shared";
import type { SearchHit } from "../types";
import {
  buildGetRequest,
  buildUriResRequest,
  parseHttpDownloadHeader,
} from "../wire/codec";
import { boundedHttpHeaderEnd } from "../wire/http";
import { browsePeer as browsePeerImpl } from "./browse";
import { DownloadTimeoutError } from "./errors";
import { openDownloadFile } from "./file_access";
import { readHttpDownloadSource } from "./http_download_reader";
import {
  connectDownloadSocket,
  downloadHttpSession,
} from "./http_download_session";
import type { PendingTransfer, TransferService } from "./service";
import type { HttpDownloadState } from "./session_types";
import type { HttpDownloadResult, TransferOptions } from "./types";

function abortError(): Error {
  return new Error("download aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function downloadOptions(
  hit: SearchHit,
  options: TransferOptions = {},
): TransferOptions {
  return { ...options, expectedSize: hit.fileSize || undefined };
}

async function existingDownloadBytes(destPath: string): Promise<number> {
  await ensureDir(path.dirname(destPath));
  return (await fileExists(destPath))
    ? (await fsp.stat(destPath)).size
    : 0;
}

function directDownloadRequest(
  attempt: DirectDownloadAttempt,
  host: string,
  port: number,
): string {
  if (attempt.kind === "uri-res") {
    return buildUriResRequest(
      attempt.urn,
      attempt.existingBytes,
      host,
      port,
    );
  }
  return buildGetRequest(
    attempt.fileIndex,
    attempt.fileName,
    attempt.existingBytes,
    host,
    port,
  );
}

/** Match a push callback to its waiting download. */
export async function handleIncomingGiv(
  transfers: TransferService,
  socket: net.Socket,
  giv: string,
) {
  transfers.trackSocket(socket);
  const text = giv.replace(/\r\n/g, "\n");
  const match = /^GIV\s+\d+:([0-9a-fA-F]{32})\/.+\n\n$/s.exec(text);
  if (!match) {
    socket.destroy();
    return;
  }
  // GIV identifies the servent; request the index and name from our pending hit.
  const serventIdHex = match[1].toLowerCase();
  const pending = transfers.shiftPendingPush(serventIdHex);
  if (!pending) {
    socket.destroy();
    return;
  }
  try {
    const result = await transfers.downloadOverSocket(
      socket,
      pending.result.fileIndex,
      pending.result.fileName,
      pending.destPath,
      downloadOptions(pending.result, pending.transferOptions),
    );
    pending.resolve(result);
  } catch (error) {
    pending.reject(error);
  }
}

/** Resume an indexed file download over an existing socket. */
export async function downloadOverSocket(
  transfers: TransferService,
  socket: net.Socket,
  fileIndex: number,
  fileName: string,
  destPath: string,
  options: TransferOptions = {},
): Promise<HttpDownloadResult> {
  throwIfAborted(options.signal);
  const existing = await existingDownloadBytes(destPath);
  return await downloadHttpSession({
    transfers,
    socket,
    destPath,
    options,
    label: `${socket.remoteAddress || "?"}:${socket.remotePort || "?"}`,
    start: existing,
    request: (start) =>
      buildGetRequest(
        fileIndex,
        fileName,
        start,
        socket.remoteAddress || undefined,
        socket.remotePort || undefined,
      ),
  });
}

/** Download a request, updating ranges across reconnects. */
export async function directDownloadViaRequest(
  transfers: TransferService,
  host: string,
  port: number,
  request: string,
  destPath: string,
  existing: number,
  options: TransferOptions = {},
): Promise<HttpDownloadResult> {
  const reconnect = () =>
    connectDownloadSocket(transfers, host, port, options);
  return await downloadHttpSession({
    transfers,
    socket: await reconnect(),
    reconnect,
    destPath,
    options,
    label: `${host}:${port}`,
    start: existing,
    request: (start) =>
      request.replace(
        /^Range: bytes=\d+-\r$/m,
        `Range: bytes=${start}-\r`,
      ),
  });
}

/** Download a hit directly with URN-to-index fallback. */
export async function directDownload(
  transfers: TransferService,
  hit: SearchHit,
  destPath: string,
  options: TransferOptions = {},
): Promise<HttpDownloadResult> {
  throwIfAborted(options.signal);
  const existing = await existingDownloadBytes(destPath);

  const errors: string[] = [];
  const attempts = directDownloadAttempts({
    fileIndex: hit.fileIndex,
    fileName: hit.fileName,
    remoteHost: hit.remoteHost,
    remotePort: hit.remotePort,
    sha1Urn: hit.sha1Urn,
    existingBytes: existing,
    serveUriRes: transfers.config().serveUriRes,
  });
  for (const planned of attempts) {
    const attempt = {
      ...planned,
      existingBytes: await existingDownloadBytes(destPath),
    };
    try {
      return await transfers.directDownloadViaRequest(
        hit.remoteHost,
        hit.remotePort,
        directDownloadRequest(attempt, hit.remoteHost, hit.remotePort),
        destPath,
        attempt.existingBytes,
        downloadOptions(hit, options),
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const method = attempt.kind === "uri-res" ? "uri-res" : "/get";
      errors.push(`${method}: ${errMsg(error)}`);
      if (error instanceof DownloadTimeoutError) {
        throw new DownloadTimeoutError(error.phase, errors.join("; "));
      }
      if (!attempt.fallbackOnFailure) break;
    }
  }
  throw new Error(errors.join("; "));
}

/** Validate buffered headers and open the destination file. */
export function initializeHttpDownloadState(
  _transfers: TransferService,
  state: HttpDownloadState,
  destPath: string,
  requestedStart: number,
  onWriteError: (error: Error) => void,
): void {
  const raw = state.buf.toString("latin1");
  const cut = boundedHttpHeaderEnd(raw);
  if (cut === -1) return;

  state.headerDone = true;
  const parsed = parseHttpDownloadHeader(
    raw.slice(0, cut),
    requestedStart,
  );
  state.remaining = parsed.remaining;
  state.finalStart = parsed.finalStart;
  state.range = parsed.range;
  state.connectionClose = parsed.connectionClose;
  state.ws = fs.createWriteStream(destPath, {
    fd: openDownloadFile(destPath, state.finalStart),
    start: state.finalStart,
  });
  state.ws.on("error", onWriteError);
  state.buf = state.buf.subarray(cut);
}

/** Write buffered body bytes within the expected length. */
export function writeHttpDownloadBody(
  _transfers: TransferService,
  state: HttpDownloadState,
): void {
  if (!state.ws) return;
  const take = Math.min(state.remaining, state.buf.length);
  if (take <= 0) return;
  const chunkOut = state.buf.subarray(0, take);
  state.ws.write(chunkOut);
  state.bodyBytes += chunkOut.length;
  state.remaining -= take;
  state.buf = state.buf.subarray(take);
}

/** Buffer response bytes and advance header and body parsing. */
export function consumeHttpDownloadChunk(
  transfers: TransferService,
  state: HttpDownloadState,
  destPath: string,
  requestedStart: number,
  onWriteError: (error: Error) => void,
  chunk: Buffer,
): void {
  state.buf = Buffer.concat([state.buf, chunk]);
  if (!state.headerDone) {
    transfers.initializeHttpDownloadState(
      state,
      destPath,
      requestedStart,
      onWriteError,
    );
  }
  transfers.writeHttpDownloadBody(state);
}

/** Read one HTTP response into the destination file. */
export async function readHttpDownload(
  transfers: TransferService,
  socket: net.Socket,
  destPath: string,
  label: string,
  requestedStart: number,
  options: TransferOptions = {},
): Promise<HttpDownloadResult> {
  return await readHttpDownloadSource({
    attach: ({ onChunk, onEnd, onError, onTimeout }) => {
      const onData = (chunk: string | Buffer) =>
        onChunk(Buffer.from(chunk));
      socket.on("error", onError);
      socket.on("data", onData);
      socket.on("end", onEnd);
      socket.on("close", onEnd);
      socket.on("timeout", onTimeout);
      socket.setTimeout(transfers.config().downloadTimeoutMs);
      return () => {
        socket.off("timeout", onTimeout);
        socket.setTimeout(0);
        socket.off("error", onError);
        socket.off("data", onData);
        socket.off("end", onEnd);
        socket.off("close", onEnd);
      };
    },
    consumeChunk: (state, targetPath, start, onWriteError, chunk) => {
      const wasReadingHeaders = !state.headerDone;
      transfers.consumeHttpDownloadChunk(
        state,
        targetPath,
        start,
        onWriteError,
        chunk,
      );
      if (wasReadingHeaders && state.headerDone) {
        socket.setTimeout(transfers.config().downloadIdleTimeoutMs);
      }
    },
    destPath,
    destroyOnFailure: () => socket.destroy(),
    incompleteMessage: "connection closed before full body received",
    label,
    options,
    requestedStart,
    timeoutMs: transfers.config().downloadTimeoutMs,
    bodyTimeoutMs: transfers.config().downloadIdleTimeoutMs,
  });
}

/** Request a push callback and await its download. */
export async function sendPush(
  transfers: TransferService,
  hit: SearchHit,
  destPath: string,
  options: TransferOptions = {},
): Promise<HttpDownloadResult> {
  throwIfAborted(options.signal);
  const send = transfers.deps.router.preparePush(hit);
  let pendingEntry: PendingTransfer | undefined;
  const pending = new Promise<HttpDownloadResult>((resolve, reject) => {
    pendingEntry = {
      serventIdHex: hit.serventIdHex,
      result: hit,
      destPath,
      transferOptions: options,
      createdAt: transfers.now(),
      resolve,
      reject,
    };
    transfers.enqueuePendingPush(pendingEntry);
  });
  const removePending = () => {
    if (!pendingEntry) return;
    const queue = transfers.pendingPushes.get(pendingEntry.serventIdHex);
    if (!queue) return;
    const keep = queue.filter((candidate) => candidate !== pendingEntry);
    if (keep.length)
      transfers.pendingPushes.set(pendingEntry.serventIdHex, keep);
    else transfers.pendingPushes.delete(pendingEntry.serventIdHex);
  };
  const onAbort = () => {
    removePending();
    pendingEntry?.reject(abortError());
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  send();
  try {
    return await pending;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Fetch a peer's shared-file listing and count ingested hits. */
export async function browsePeer(
  transfers: TransferService,
  peerKey: string,
  descriptorId: Buffer,
): Promise<number> {
  return await browsePeerImpl(transfers, peerKey, descriptorId);
}
