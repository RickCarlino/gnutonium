# Contributor Guide

Repository internals and verification workflows live here. For embedding the engine in an application, see [DEVELOPER.md](DEVELOPER.md).

## Reading the Protocol Implementation

Start at [servent.ts](src/servent.ts). Its constructor connects the owners;
`start()` and `stop()` show their lifecycles. The CLI enters through
[bin/gnutonium.ts](bin/gnutonium.ts), while library consumers enter through
[src/protocol.ts](src/protocol.ts).

The source tree groups runtime code with the decisions and types it owns:

```text
src/
  servent.ts             Application composition and public actions
  protocol.ts            Public library exports
  cli*.ts                Commands, output, and interactive monitoring
  connections/           Dialing, ingress, handshakes, and peer sessions
    policy/              Handshake headers, capabilities, and admission rules
    topology/            Peer roles and connection-slot decisions
  routing/               Descriptor dispatch, forwarding, and return routes
    descriptors/         Duplicate, lifetime, response-route, and pong rules
    qrp/                 Query Routing Protocol tables, hashes, and patches
  search/                Search sessions, query interpretation, isolated results
  shares/                Catalog, matching, hashing, and share-index storage
  transfers/             HTTP, browse, direct downloads, and push callbacks
  downloads/             Job queue, retries, verification, and job storage
  discovery/             Remembered peers and local endpoint observations
    gwebcache/           Bootstrap and cache reporting
  config/                Configuration, saved documents, and peer-state format
  wire/                  Message encoders/decoders, headers, URNs, and GUIDs
  transport/             Socket ownership and shared socket operations
```

`types.ts`, `const.ts`, and `shared.ts` contain shared contracts, constants,
and generic helpers. Connection types live in `connections/types.ts`, wire
formats in `wire/types.ts`, and HTTP session state in
`transfers/session_types.ts`. Package export paths remain `gnutonium`,
`gnutonium/types`, `gnutonium/gwebcache`, and `gnutonium/query-routing`.

Follow one flow at a time:

1. **Local files to search results:** [shares/library.ts](src/shares/library.ts)
   scans files and maintains stable indexes and cached hashes. Catalog
   publication updates local QRP. [search/service.ts](src/search/service.ts)
   manages searches; [search/results.ts](src/search/results.ts) stores results.
2. **A query across the network:** begin with [search/service.ts](src/search/service.ts)
   and [routing/origin.ts](src/routing/origin.ts), then follow packet dispatch and
   query/hit handlers in [routing/messages.ts](src/routing/messages.ts).
   [routing/queries.ts](src/routing/queries.ts) chooses peers using the pure
   routing rules; [routing/qrp_exchange.ts](src/routing/qrp_exchange.ts)
   exchanges their QRP tables. Original payloads remain available for forwarding.
3. **An incoming connection:** `handleProbe()` in
   [connections/handshake.ts](src/connections/handshake.ts) classifies Gnutella,
   HTTP, and GIV. After negotiation, [connections/session.ts](src/connections/session.ts)
   owns compression, listeners, and timers, while
   [connections/transport.ts](src/connections/transport.ts) frames descriptors
   and calls the router. [wire/codec.ts](src/wire/codec.ts) defines their bytes.
4. **A download:** `queueDownloadResult()` resolves the selected hit before
   calling [downloads/manager.ts](src/downloads/manager.ts). The queue owns
   scheduling, retries, pause, verification, and incomplete-file recovery.
   [transfers/download.ts](src/transfers/download.ts) owns direct and push
   transport. PUSH registers a callback, the router sends its descriptor,
   and GIV hands the socket to an HTTP download session.
5. **Discovery and saving:** [discovery/runtime.ts](src/discovery/runtime.ts)
   coordinates remembered peers and GWebCache work.
   [discovery/local_address.ts](src/discovery/local_address.ts) owns endpoint
   confidence. [config/runtime.ts](src/config/runtime.ts) provides detached
   settings; [config/document.ts](src/config/document.ts) loads and saves the
   existing document format. Share and download stores stay with those owners.

Unit tests follow the same domain directories under `tests/unit/`.
`tests/unit/servent/` covers behavior spanning several owners; reusable node
and socket fixtures live in `tests/helpers/`. Read
[tests/integration/protocol.test.ts](tests/integration/protocol.test.ts)
alongside the query and transfer flows to see small working networks.

Run `bun run verify` for deterministic checks and standalone builds. See
[tests/interop/README.md](tests/interop/README.md) for pinned GTK-Gnutella
checks and [acceptance.json](tests/interop/acceptance.json) for recorded
compatibility results.

Verification has a 600-second overall deadline. Override it with
`GNUTONIUM_VERIFY_TIMEOUT_SEC=900 bun run verify` when needed. On timeout
(exit 124), interruption, or command failure, its supervisor terminates the
verification process groups, including detached groups created by nested
supervisors, then sends SIGKILL after a two-second grace period if processes
remain. Inherited environment markers identify detached descendants even
after their original parents exit. This uses Unix process groups and `ps`,
matching the Bash verification scripts.

## Import Organization

Run `bun run imports:organize` to organize imports across `src`, `bin`,
`tests`, and TypeScript scripts. It moves imports above declarations, then
uses TypeScript's language service to sort and merge imports and remove
unused bindings, followed by the repository's Prettier settings. Shebangs,
file headers, and directive prologues are preserved.

`bun run fix` includes this step. `bun run imports:check` checks without
writing; `bun run verify` includes that check to keep the layout consistent.

### Session command language

`src/cli.ts` composes terminal events, completion, and shutdown. The command language lives in `src/cli/`: `tokens.ts` scans strict submissions and tolerant edits; `commands.ts` defines typed parsing, aliases, and help; `parse.ts` returns diagnostics; `selectors.ts` parses intervals; `resolve.ts` freezes target membership from owner snapshots; `batch.ts` and `execute.ts` invoke owner APIs; `runner.ts` serializes REPL and scripted input; `complete.ts` supplies candidates and replacement spans. No CLI-owned search or download state is retained.

The CLI integration tests use temporary directories and localhost-only cache/peer fixtures. `tests/integration/cli_pty.test.ts` uses Bun's real PTY support to check Tab, multiple candidates, middle-of-line edits during monitor/throbber redraw, rapid submissions, quit, and Ctrl-C during sleep. These PTY tests run on Linux/macOS and are skipped on Windows. After building, repeat the process and PTY scenarios against a host binary:

```bash
GNUTONIUM_CLI_BINARY="$PWD/dist/gnutonium-linux-x64" bun test tests/integration/cli.test.ts tests/integration/cli_pty.test.ts
```

The command-language implementation was verified with Bun 1.4.2 and the compiled Linux x64 binary. All eleven configured targets compile; interactive behavior on macOS, Windows, ARM64, and musl has not been runtime-tested here.
