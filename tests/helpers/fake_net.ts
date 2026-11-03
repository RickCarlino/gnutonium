import { EventEmitter } from "node:events";
import net from "node:net";
import { Duplex } from "node:stream";

type AddressInfo = net.AddressInfo;

function connectionRefused(
  host: string,
  port: number,
): Error & {
  code: string;
} {
  return Object.assign(new Error(`connect ECONNREFUSED ${host}:${port}`), {
    code: "ECONNREFUSED",
  });
}

function addressInUse(
  host: string,
  port: number,
): Error & {
  code: string;
} {
  return Object.assign(new Error(`listen EADDRINUSE ${host}:${port}`), {
    code: "EADDRINUSE",
  });
}

class FakeSocket extends Duplex {
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;
  ended = false;
  private peer?: FakeSocket;
  private timeoutMs = 0;
  private timeoutCallback?: () => void;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private closingFromPeer = false;

  constructor() {
    super({ allowHalfOpen: false });
    this.on("end", () => {
      this.ended = true;
      this.clearSocketTimeout();
    });
    this.on("close", () => this.clearSocketTimeout());
  }

  pairWith(peer: FakeSocket): void {
    this.peer = peer;
  }

  setNoDelay(_noDelay: boolean): this {
    return this;
  }

  setTimeout(timeoutMs: number, callback?: () => void): this {
    this.timeoutMs = Math.max(0, timeoutMs);
    this.timeoutCallback = callback;
    this.armSocketTimeout();
    return this;
  }

  override _read(_size: number): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.touch();
    const peer = this.peer;
    if (!peer || peer.destroyed) {
      callback(new Error("socket closed"));
      return;
    }
    const payload = Buffer.from(chunk);
    queueMicrotask(() => {
      if (!peer.destroyed) {
        peer.touch();
        peer.push(payload);
      }
    });
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    const peer = this.peer;
    queueMicrotask(() => peer?.closeReadableFromPeer());
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error: Error | null) => void,
  ): void {
    this.clearSocketTimeout();
    const peer = this.peer;
    if (peer && !peer.destroyed && !this.closingFromPeer) {
      queueMicrotask(() => peer.destroyFromPeer());
    }
    callback(error);
  }

  private destroyFromPeer(): void {
    if (this.destroyed) return;
    this.closingFromPeer = true;
    this.closeReadableFromPeer();
    super.destroy();
    this.closingFromPeer = false;
  }

  private closeReadableFromPeer(): void {
    if (this.readableEnded) return;
    this.ended = true;
    this.push(null);
  }

  private armSocketTimeout(): void {
    this.clearSocketTimeout();
    if (!this.timeoutMs || this.destroyed) return;
    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = null;
      if (this.destroyed) return;
      this.emit("timeout");
      this.timeoutCallback?.();
    }, this.timeoutMs);
  }

  private clearSocketTimeout(): void {
    if (!this.timeoutTimer) return;
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
  }

  private touch(): void {
    if (this.timeoutMs > 0) this.armSocketTimeout();
  }

  address(): AddressInfo | null {
    if (!this.localAddress || !this.localPort) return null;
    return {
      address: this.localAddress,
      family: "IPv4",
      port: this.localPort,
    };
  }
}

class FakeServer extends EventEmitter {
  private listening = false;
  private listenHost = "127.0.0.1";
  private listenPort = 0;

  constructor(
    private readonly network: FakeNet,
    listener?: (socket: net.Socket) => void,
  ) {
    super();
    if (listener) {
      this.on(
        "connection",
        listener as unknown as (...args: unknown[]) => void,
      );
    }
  }

  listen(
    port: number,
    host?: string | (() => void),
    callback?: () => void,
  ): this {
    const listenHost = typeof host === "string" ? host : "127.0.0.1";
    const onListen =
      typeof host === "function" ? host : callback || (() => void 0);
    const listenPort = port > 0 ? port : this.network.allocatePort();
    const key = this.network.serverKey(listenHost, listenPort);
    if (this.network.hasServer(key)) {
      queueMicrotask(() =>
        this.emit("error", addressInUse(listenHost, listenPort)),
      );
      return this;
    }
    this.listenHost = listenHost;
    this.listenPort = listenPort;
    this.listening = true;
    this.network.register(key, this);
    queueMicrotask(() => {
      onListen();
      this.emit("listening");
    });
    return this;
  }

  close(callback?: (error?: Error) => void): this {
    if (this.listening) {
      this.network.unregister(
        this.network.serverKey(this.listenHost, this.listenPort),
      );
      this.listening = false;
    }
    queueMicrotask(() => {
      callback?.();
      this.emit("close");
    });
    return this;
  }

  address(): AddressInfo | null {
    if (!this.listening) return null;
    return {
      address: this.listenHost,
      family: "IPv4",
      port: this.listenPort,
    };
  }

  accept(socket: FakeSocket): void {
    if (!this.listening) {
      socket.destroy(connectionRefused(this.listenHost, this.listenPort));
      return;
    }
    this.emit("connection", socket as unknown as net.Socket);
  }
}

class FakeNet {
  private readonly servers = new Map<string, FakeServer>();
  private readonly sockets = new Set<FakeSocket>();
  private nextPort = 20_000;

  dispose(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const server of this.servers.values()) server.close();
    this.servers.clear();
  }

  private createSocket(): FakeSocket {
    const socket = new FakeSocket();
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    return socket;
  }

  allocatePort(): number {
    return this.nextPort++;
  }

  serverKey(host: string, port: number): string {
    return `${host}:${port}`;
  }

  hasServer(key: string): boolean {
    return this.servers.has(key);
  }

  register(key: string, server: FakeServer): void {
    this.servers.set(key, server);
  }

  unregister(key: string): void {
    this.servers.delete(key);
  }

  findServer(host: string, port: number): FakeServer | undefined {
    return (
      this.servers.get(this.serverKey(host, port)) ||
      this.servers.get(this.serverKey("0.0.0.0", port))
    );
  }

  createServer(listener?: (socket: net.Socket) => void): net.Server {
    return new FakeServer(this, listener) as unknown as net.Server;
  }

  createConnection(options: net.NetConnectOpts): net.Socket {
    const tcpOptions = options as net.NetConnectOpts & {
      host?: string;
      port?: number;
    };
    const host = String(tcpOptions.host || "127.0.0.1");
    const port = Number(tcpOptions.port || 0);
    const socket = this.createSocket();
    const server = this.findServer(host, port);
    if (!server) {
      queueMicrotask(() => socket.destroy(connectionRefused(host, port)));
      return socket as unknown as net.Socket;
    }

    const serverSocket = this.createSocket();
    const clientPort = this.allocatePort();

    socket.localAddress = "127.0.0.1";
    socket.localPort = clientPort;
    socket.remoteAddress = host;
    socket.remotePort = port;

    serverSocket.localAddress = host;
    serverSocket.localPort = port;
    serverSocket.remoteAddress = socket.localAddress;
    serverSocket.remotePort = clientPort;

    socket.pairWith(serverSocket);
    serverSocket.pairWith(socket);

    queueMicrotask(() => {
      if (socket.destroyed || serverSocket.destroyed) return;
      server.accept(serverSocket);
      socket.emit("connect");
    });

    return socket as unknown as net.Socket;
  }
}

/** Run a test with fake sockets and restore network functions. */
export async function withFakeNet<T>(fn: () => Promise<T>): Promise<T> {
  const fake = new FakeNet();
  const original = {
    createConnection: net.createConnection,
    createServer: net.createServer,
  };

  (
    net as unknown as {
      createConnection: typeof net.createConnection;
      createServer: typeof net.createServer;
    }
  ).createConnection = ((options: net.NetConnectOpts) =>
    fake.createConnection(options)) as typeof net.createConnection;
  (
    net as unknown as {
      createConnection: typeof net.createConnection;
      createServer: typeof net.createServer;
    }
  ).createServer = ((listener?: (socket: net.Socket) => void) =>
    fake.createServer(listener)) as typeof net.createServer;

  try {
    return await fn();
  } finally {
    fake.dispose();
    (
      net as unknown as {
        createConnection: typeof net.createConnection;
        createServer: typeof net.createServer;
      }
    ).createConnection = original.createConnection;
    (
      net as unknown as {
        createConnection: typeof net.createConnection;
        createServer: typeof net.createServer;
      }
    ).createServer = original.createServer;
  }
}
