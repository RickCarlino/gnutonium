import type net from "node:net";
import type { PeerConnections } from "../connections/connections";
import type { LocalAddress } from "../discovery/local_address";
import type { MessageRouter } from "../routing/router";
import type { ShareLibrary } from "../shares/library";
import { SocketRegistry } from "../transport/socket_registry";
import type {
  GnutellaEvent,
  GnutellaServentCollaborators,
  OwnerArguments,
  PendingPush,
  RuntimeConfig,
  SearchHit,
} from "../types";
import { randomId16 } from "../wire/ids";
import * as transfer from "./download";
import * as http from "./http_sessions";
import { fulfillPush } from "./push_upload";
import * as files from "./serve_files";
import type { HttpDownloadResult, TransferOptions } from "./types";

export type PendingTransfer = Omit<PendingPush, "resolve"> & {
  resolve: (result: HttpDownloadResult) => void;
};

type TransferDependencies = {
  config: () => RuntimeConfig;
  now: () => number;
  emit: (event: GnutellaEvent) => void;
  serventId: Buffer;
  network: Pick<
    GnutellaServentCollaborators["netFactory"],
    "createConnection"
  >;
  scheduler: Pick<
    GnutellaServentCollaborators["scheduler"],
    "setTimeout" | "clearTimeout"
  >;
  address: Pick<
    LocalAddress,
    "currentAdvertisedHost" | "currentAdvertisedPort" | "isSelfPeer"
  >;
  shares: Pick<ShareLibrary, "list" | "byIndex" | "byUrn">;
  router: Pick<MessageRouter, "preparePush" | "ingestBrowse">;
  connections: Pick<PeerConnections, "peers" | "peerBrowseTarget">;
};
/** Owns HTTP transfers, push callbacks, and transfer sockets. */
export class TransferService {
  readonly pendingPushes = new Map<string, PendingTransfer[]>();
  private readonly sockets = new SocketRegistry();

  /** Attach network, share, and routing dependencies. */
  constructor(readonly deps: TransferDependencies) {}

  /** Download a search hit directly to its destination. */
  async direct(
    hit: SearchHit,
    destination: string,
    options: TransferOptions = {},
  ): Promise<void> {
    await this.directDownload(hit, destination, options);
  }

  /** Download a search hit through a push callback. */
  async push(
    hit: SearchHit,
    destination: string,
    options: TransferOptions = {},
  ): Promise<void> {
    await this.sendPush(hit, destination, options);
  }

  /** Fetch a peer's shared-file listing and count ingested hits. */
  browsePeer(
    ...args: OwnerArguments<Parameters<typeof transfer.browsePeer>>
  ): ReturnType<typeof transfer.browsePeer> {
    return transfer.browsePeer(this, ...args);
  }

  /** Match a push callback to its waiting download. */
  handleIncomingGiv(
    ...args: OwnerArguments<Parameters<typeof transfer.handleIncomingGiv>>
  ): ReturnType<typeof transfer.handleIncomingGiv> {
    return transfer.handleIncomingGiv(this, ...args);
  }

  /** Attach handlers and serve requests on an incoming socket. */
  startHttpSession(
    ...args: OwnerArguments<Parameters<typeof http.startHttpSession>>
  ): ReturnType<typeof http.startHttpSession> {
    return http.startHttpSession(this, ...args);
  }

  /** Connect back to a requester and offer the selected share. */
  fulfillPush(
    ...args: OwnerArguments<Parameters<typeof fulfillPush>>
  ): ReturnType<typeof fulfillPush> {
    return fulfillPush(this, ...args);
  }

  /** Reject waiting pushes and destroy transfer sockets. */
  stop(): void {
    for (const queue of this.pendingPushes.values())
      for (const pending of queue)
        pending.reject(new Error("transfer service stopped"));
    this.pendingPushes.clear();
    this.sockets.close();
  }

  /** Read the current runtime configuration. */
  config(): RuntimeConfig {
    return this.deps.config();
  }

  /** Read the injected clock in milliseconds. */
  now(): number {
    return this.deps.now();
  }

  /** Generate a random GUID with Gnutella marker bytes. */
  randomId16(): Buffer {
    return randomId16();
  }

  /** Create and track an outbound socket. */
  createConnection(options: net.NetConnectOpts): net.Socket {
    return this.trackSocket(this.deps.network.createConnection(options));
  }

  /** Register a socket for owner shutdown. */
  trackSocket(socket: net.Socket): net.Socket {
    return this.sockets.add(socket);
  }

  /** Resume an indexed file download over an existing socket. */
  downloadOverSocket(
    ...args: OwnerArguments<Parameters<typeof transfer.downloadOverSocket>>
  ): ReturnType<typeof transfer.downloadOverSocket> {
    return transfer.downloadOverSocket(this, ...args);
  }

  /** Download a request, updating ranges across reconnects. */
  directDownloadViaRequest(
    ...args: OwnerArguments<
      Parameters<typeof transfer.directDownloadViaRequest>
    >
  ): ReturnType<typeof transfer.directDownloadViaRequest> {
    return transfer.directDownloadViaRequest(this, ...args);
  }

  /** Download a hit directly with URN-to-index fallback. */
  directDownload(
    ...args: OwnerArguments<Parameters<typeof transfer.directDownload>>
  ): ReturnType<typeof transfer.directDownload> {
    return transfer.directDownload(this, ...args);
  }

  /** Validate buffered headers and open the destination file. */
  initializeHttpDownloadState(
    ...args: OwnerArguments<
      Parameters<typeof transfer.initializeHttpDownloadState>
    >
  ): ReturnType<typeof transfer.initializeHttpDownloadState> {
    return transfer.initializeHttpDownloadState(this, ...args);
  }

  /** Write buffered body bytes within the expected length. */
  writeHttpDownloadBody(
    ...args: OwnerArguments<
      Parameters<typeof transfer.writeHttpDownloadBody>
    >
  ): ReturnType<typeof transfer.writeHttpDownloadBody> {
    return transfer.writeHttpDownloadBody(this, ...args);
  }

  /** Buffer response bytes and advance header and body parsing. */
  consumeHttpDownloadChunk(
    ...args: OwnerArguments<
      Parameters<typeof transfer.consumeHttpDownloadChunk>
    >
  ): ReturnType<typeof transfer.consumeHttpDownloadChunk> {
    return transfer.consumeHttpDownloadChunk(this, ...args);
  }

  /** Read one HTTP response into the destination file. */
  readHttpDownload(
    ...args: OwnerArguments<Parameters<typeof transfer.readHttpDownload>>
  ): ReturnType<typeof transfer.readHttpDownload> {
    return transfer.readHttpDownload(this, ...args);
  }

  /** Request a push callback and await its download. */
  sendPush(
    ...args: OwnerArguments<Parameters<typeof transfer.sendPush>>
  ): ReturnType<typeof transfer.sendPush> {
    return transfer.sendPush(this, ...args);
  }

  /** Find the end of the next buffered HTTP header. */
  pendingHttpSessionHeadEnd(
    ...args: OwnerArguments<
      Parameters<typeof http.pendingHttpSessionHeadEnd>
    >
  ): ReturnType<typeof http.pendingHttpSessionHeadEnd> {
    return http.pendingHttpSessionHeadEnd(this, ...args);
  }

  /** Remove and return a complete buffered HTTP header. */
  shiftHttpSessionHead(
    ...args: OwnerArguments<Parameters<typeof http.shiftHttpSessionHead>>
  ): ReturnType<typeof http.shiftHttpSessionHead> {
    return http.shiftHttpSessionHead(this, ...args);
  }

  /** Remove and return a complete buffered HTTP request. */
  shiftHttpSessionRequest(
    ...args: OwnerArguments<
      Parameters<typeof http.shiftHttpSessionRequest>
    >
  ): ReturnType<typeof http.shiftHttpSessionRequest> {
    return http.shiftHttpSessionRequest(this, ...args);
  }

  /** Serve buffered requests in order while reusable. */
  processHttpSessionRequests(
    ...args: OwnerArguments<
      Parameters<typeof http.processHttpSessionRequests>
    >
  ): ReturnType<typeof http.processHttpSessionRequests> {
    return http.processHttpSessionRequests(this, ...args);
  }

  /** Process pending requests without overlapping handlers. */
  drainHttpSession(
    ...args: OwnerArguments<Parameters<typeof http.drainHttpSession>>
  ): ReturnType<typeof http.drainHttpSession> {
    return http.drainHttpSession(this, ...args);
  }

  /** Queue a waiting download under its remote servent ID. */
  enqueuePendingPush(
    ...args: OwnerArguments<Parameters<typeof http.enqueuePendingPush>>
  ): ReturnType<typeof http.enqueuePendingPush> {
    return http.enqueuePendingPush(this, ...args);
  }

  /** Take the oldest waiting download for a servent. */
  shiftPendingPush(
    ...args: OwnerArguments<Parameters<typeof http.shiftPendingPush>>
  ): ReturnType<typeof http.shiftPendingPush> {
    return http.shiftPendingPush(this, ...args);
  }

  /** Reject and remove expired push callback requests. */
  prunePendingPushQueues(
    ...args: OwnerArguments<Parameters<typeof http.prunePendingPushQueues>>
  ): ReturnType<typeof http.prunePendingPushQueues> {
    return http.prunePendingPushQueues(this, ...args);
  }

  /** Dispatch browse or file requests and report socket reuse. */
  handleIncomingGet(
    ...args: OwnerArguments<Parameters<typeof files.handleIncomingGet>>
  ): ReturnType<typeof files.handleIncomingGet> {
    return files.handleIncomingGet(this, ...args);
  }

  /** Read HTTP method, version, and connection preferences. */
  parseExistingGetRequest(
    ...args: OwnerArguments<
      Parameters<typeof files.parseExistingGetRequest>
    >
  ): ReturnType<typeof files.parseExistingGetRequest> {
    return files.parseExistingGetRequest(this, ...args);
  }

  /** Send a 416 response and report socket reuse. */
  writeInvalidRangeResponse(
    ...args: OwnerArguments<
      Parameters<typeof files.writeInvalidRangeResponse>
    >
  ): ReturnType<typeof files.writeInvalidRangeResponse> {
    return files.writeInvalidRangeResponse(this, ...args);
  }

  /** Calculate the byte length of an inclusive range. */
  existingGetBodyLength(
    ...args: OwnerArguments<Parameters<typeof files.existingGetBodyLength>>
  ): ReturnType<typeof files.existingGetBodyLength> {
    return files.existingGetBodyLength(this, ...args);
  }

  /** Build file response headers with range and URN metadata. */
  buildExistingGetResponseHeaders(
    ...args: OwnerArguments<
      Parameters<typeof files.buildExistingGetResponseHeaders>
    >
  ): ReturnType<typeof files.buildExistingGetResponseHeaders> {
    return files.buildExistingGetResponseHeaders(this, ...args);
  }

  /** End the socket unless the request allows reuse. */
  finishExistingGetResponse(
    ...args: OwnerArguments<
      Parameters<typeof files.finishExistingGetResponse>
    >
  ): ReturnType<typeof files.finishExistingGetResponse> {
    return files.finishExistingGetResponse(this, ...args);
  }

  /** Stream a file range to the requester. */
  streamExistingGetBody(
    ...args: OwnerArguments<Parameters<typeof files.streamExistingGetBody>>
  ): ReturnType<typeof files.streamExistingGetBody> {
    return files.streamExistingGetBody(this, ...args);
  }

  /** Serve a file or its headers with byte-range support. */
  handleExistingGet(
    ...args: OwnerArguments<Parameters<typeof files.handleExistingGet>>
  ): ReturnType<typeof files.handleExistingGet> {
    return files.handleExistingGet(this, ...args);
  }
}
