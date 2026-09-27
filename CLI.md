# CLI Guide

This is the full guide to Gnutonium in the terminal.

If you just want to get connected and run your first search, start with [QUICKSTART.md](QUICKSTART.md).

## Running Gnutonium

You can run Gnutonium either as a prebuilt binary or directly from the source checkout.

Prebuilt binaries are available on the [releases page](https://github.com/RickCarlino/gnutella-bun-client/releases).

If you're running from source, install the dependencies first:

```bash
bun install
```

The examples in this guide use:

```bash
gnutonium
```

If you're running from source, use this instead:

```bash
bun run bin/gnutonium.ts
```

If you're using a compiled binary somewhere else on your system, substitute its path as needed.

## First-Time Setup

Create a config file:

```bash
gnutonium init --config gnutella.json
```

This creates a default config unless the file already exists.

Then start Gnutonium:

```bash
gnutonium run --config gnutella.json
```

Once it's running, you'll be dropped into the interactive CLI.

Try:

```text
status
peers
query jazz piano
```

## Configuration

Gnutonium stores both your settings and a small amount of remembered network state in the same JSON file.

Most people won't need to change much beyond the data directory and networking settings.

### Main Settings

| Setting                               | What it does                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.data_dir`                     | Root directory for Gnutonium's files. Downloads go under `<data_dir>/downloads` and partial downloads under `<data_dir>/incomplete` by default.          |
| `config.listen_ip`                    | Local IPv4 address to listen on. `0.0.0.0` is usually what you want.                                                                                     |
| `config.listen_port`                  | Local TCP port Gnutonium listens on.                                                                                                                     |
| `config.advertised_ip`                | Public IPv4 address other peers should use to reach you. Useful when your public address differs from your local bind address.                           |
| `config.advertised_port`              | Public TCP port other peers should use to reach you.                                                                                                     |
| `config.blocked_ips`                  | IPv4 addresses Gnutonium should refuse, forget, and stop dialing.                                                                                        |
| `config.gwebcaches`               | Cache objects keyed by URL, including configured and discovered caches. Missing or empty collections are populated with bundled defaults.                                                       |
| `config.ultrapeer`                    | Set to `true` to run as an ultrapeer. Leave it `false` for a normal lightweight client.                                                                  |
| `config.max_ultrapeer_connections`    | Maximum number of ultrapeer-to-ultrapeer connections.                                                                                                    |
| `config.max_leaf_connections`         | Maximum number of leaf connections.                                                                                                                      |
| `config.max_ttl`                      | Maximum descriptor TTL Gnutonium will advertise or relay. Defaults to `4`.                                                                               |
| `config.log_ignore`                   | Event categories to hide while monitoring is enabled.                                                                                                    |
| `config.downloads_dir`                | Where completed downloads are stored. Relative paths are resolved under `data_dir`.                                                                      |
| `config.incomplete_downloads_dir`     | Where partial downloads are kept. Relative paths are resolved under `data_dir`.                                                                          |
| `config.download_queue_size`          | Maximum number of active downloads. Defaults to `6`.                                                                                                     |
| `config.download_max_active_per_host` | Maximum simultaneous downloads from one remote host. Defaults to `2`.                                                                                    |
| `config.download_retry_limit`         | Number of consecutive attempts a source gets without making progress before the job fails. Defaults to `10`. Saving new bytes resets the counter.        |
| `config.download_retry_backoff_sec`   | How long to wait before retrying a failed source. Defaults to `60` seconds.                                                                              |
| `config.download_idle_timeout_ms`     | Maximum time a download body can stop making progress before timing out. Defaults to `60000` ms. Connection and HTTP-header timeouts stay at 15 seconds. |
| `config.verify_downloads`             | Verifies completed files against their SHA1 URN when one is available. Defaults to `true`.                                                               |

### Remembered State

Gnutonium also keeps a little state between runs:

| Setting                | What it does                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `state.peers`          | Peers Gnutonium can try again the next time it starts. You don't need to populate this manually; Gnutonium can bootstrap on its own. |
| `state.servent_id_hex` | Your node's persistent Gnutella identity. Normally, don't touch it.                                                                  |

## Shared Files and Downloads

By default, Gnutonium uses:

```text
<data_dir>/downloads
```

for both:

- files you want to share
- downloads that have completed

Partial downloads are kept in:

```text
<data_dir>/incomplete
```

Gnutonium keeps partial files across restarts, so interrupted downloads can resume later.

When a download has a SHA1 URN, Gnutonium verifies the completed file before moving it into the downloads directory.

## Commands

### Basic Commands

| Command                                  | What it does                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `help`                                   | Shows the available commands.                                                                                  |
| `status`                                 | Shows a quick summary of peers, shared files, search results, and known peers.                                 |
| `monitor [on\|off\|all\|downloads]`      | Controls live logging.                                                                                         |
| `clear [searches\|downloads] [selector]` | Bare `clear` clears searches. Handles, ranges, and statuses select searches or downloads; see selectors below. |
| `save`                                   | Writes the current configuration and remembered state to disk.                                                 |
| `sleep [seconds]`                        | Pauses the command queue; defaults to zero. Nonnegative decimal seconds, including fractions, are accepted.    |
| `quit` / `exit`                          | Shuts Gnutonium down cleanly.                                                                                  |

### Peers and Networking

| Command             | What it does                                                                  |
| ------------------- | ----------------------------------------------------------------------------- |
| `peers`             | Lists your current connections. Connected peers get short names such as `p1`. |
| `connect <ip:port>` | Connects to a peer and remembers it for future runs.                          |
| `ping [ttl]`        | Sends a Gnutella ping.                                                        |
| `blocked`           | Shows blocked IPv4 addresses.                                                 |
| `block <ipv4>`      | Blocks an IPv4 address and disconnects matching peers.                        |
| `unblock <ipv4>`    | Removes an address from the block list.                                       |

### Searching

Start a search with:

```text
query jazz piano
```

Useful search commands:

| Command                     | What it does                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `query <search terms...>`   | Starts a search.                                                                           |
| `queries`                   | Lists search handles, result counts, and search terms.                                     |
| `results [selector]`        | Shows results for all searches, or selected search handles, full IDs, ranges, or statuses. |
| `info <selector>`           | Shows more information about a search result or download job.                              |
| `magnet <selector>`         | Prints a magnet link for a search result.                                                  |
| `browse <peerKey\|ip:port>` | Requests a peer's full shared-file list.                                                   |

Each search gets an ID such as `q1`, `q2`, and so on.

Search results also get numbers. Those numbers are what you pass to commands like `info`, `magnet`, and `download`.

### Sharing and Downloads

| Command                          | What it does                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `shares`                         | Shows the files you're currently sharing.                                                                                     |
| `rescan`                         | Rescans the share directory and rebuilds the local share index.                                                               |
| `download <selector> [destPath]` | Starts or updates a background download job. If no destination is given, Gnutonium chooses a path in the downloads directory. |
| `downloads [selector]`           | Shows all download jobs, or only the selected handles, ranges, or statuses.                                                   |
| `pause <selector>`               | Pauses a queued or active download without deleting the partial file.                                                         |
| `resume <selector>`              | Requeues a paused or failed download.                                                                                         |
| `remove <selector>`              | Removes a download job and deletes its incomplete file. Completed files are left alone.                                       |

Searches and downloads are separate.

If you run:

```text
clear
```

your search results disappear, but active and queued downloads keep running.

Use:

```text
downloads
```

to see download progress, or:

```text
info d5
```

to inspect a particular job.

## Selecting Multiple Targets

Use commas for unions and inclusive ascending ranges:

```text
download 3,4,7
download 3-7,12
download 3, 4, 7
remove d10 - d20
pause active,queued
resume failed,verification_failed
clear complete
clear searches q1-q3,q7
downloads active,queued
results q1,q3-q5
info d2,failed
magnet 3-7
```

Result selectors (`download`, `magnet`, and the result form of `info`) accept positive result numbers, lists, and ranges. They do not accept statuses or `all`. Search selectors (`results` and `clear searches`) accept `qN` handles, full search IDs as individual list items, handle ranges, `active`, `complete`, `failed`, and `all`. Full search IDs retain exact case matching and cannot be range endpoints.

Download selectors (`pause`, `resume`, `remove`, `downloads`, `clear downloads`, and the download form of `info`) accept `dN` handles, lists, ranges, and these exact statuses:

```text
queued active paused verifying complete failed verification_failed
```

`failed` does not include `verification_failed`; `active` does not include `verifying`. Download commands also accept `all`, except `info`, where it would be ambiguous. `info` cannot mix result numbers and download jobs in one selection. A literal `|` is not selector syntax: use commas to combine statuses.

`clear` chooses its domain from the syntax:

| Form                                                                | Effect                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------- |
| `clear`                                                             | Clear all searches and results; downloads keep running. |
| `clear q2` or `clear <full-search-id>`                              | Clear one search.                                       |
| `clear q2-q5,q8`                                                    | Clear selected searches.                                |
| `clear d5` or `clear d10-d20`                                       | Remove selected download jobs.                          |
| `clear active` / `clear queued` / `clear failed` / `clear complete` | Remove downloads in exactly that status.                |
| `clear downloads all`                                               | Remove all retained downloads.                          |
| `clear searches active` or `clear searches all`                     | Explicitly select searches.                             |

Unqualified status selectors choose downloads. Mixed search/download selections and `clear all` are rejected. Use the explicit forms to select all. **Clearing downloads uses the same operation as `remove`: it deletes incomplete files and preserves completed files.** There is no additional confirmation prompt.

Ranges must repeat the prefix (`d10-d20`, not `d10-20`). Numbers and handle suffixes must be positive safe integers without signs, decimals, exponent notation, or leading zeros. Ranges skip missing IDs, including gaps left by removals; a range or status matching nothing succeeds without actions. An explicitly named missing target rejects the entire command before any action.

Items retain their input order. Each range or status expands in numeric order, and repeated targets execute once. Even extremely large ranges only inspect retained entities. Commands resolve the whole selection from one snapshot. Later arrivals or status changes do not add targets to an executing batch. Owner behavior is preserved, including pause/resume no-ops for completed jobs.

A destination is allowed only when a download selection resolves to one unique result:

```text
download 3 "music/live recording.flac"
download 3,3 music/live\ recording.flac
```

`download 3 4` means result 3 with destination `4`; whitespace alone does not join targets. Commas and hyphens in query text, addresses, and destination paths retain their ordinary meaning. A quoted selector may contain a whole expression, such as `download "3, 4-7"`. Quote paths beginning with selector punctuation.

After preflight, actions run sequentially. Runtime failures are reported per target and remaining targets continue; completed actions are not rolled back. Batch totals distinguish successes, detectable no-ops, and failures. Download totals count input results separately from newly created jobs because several results can merge into one job.

## Tab Completion and Input Validation

Press Tab to complete command names and aliases (`search` and `exit`), monitor modes, explicit `clear` domains, statuses, existing result numbers, search/download handles, connected peer handles for `browse`, and blocked addresses for `unblock`. Numbered handles sort numerically. Tab completes the current comma-separated member or ascending range endpoint and preserves text after the cursor. Multiple matches use ordinary readline behavior.

Completion reads local snapshots only. It does not connect, search, read the filesystem, or run commands. Status keywords are offered even when no entities currently match. There is no destination-path or shell-option completion. Enter reparses against fresh state, so a removed target suggested earlier receives the same missing-target error as a typed ID.

Command names, aliases, short handle prefixes, and keywords are case-insensitive. Query text and paths keep their case and content. Quoted strings and backslash escapes are supported. Submitted unfinished quotes, dangling escapes, surplus arguments, and malformed numbers now produce diagnostics instead of being silently accepted. During editing, incomplete quotes and escapes are normal and Tab prints no errors.

`ping` accepts an optional integer TTL from 1 to 255. `sleep` accepts optional nonnegative decimal seconds, up to 2147483.647. The REPL and `--exec` share a command queue, including `sleep`. Errors do not stop later scripted commands. `quit` stops the queue and discards pending commands; Ctrl-C still interrupts a long command directly.

## Common Workflows

### Search for Something and Download It

A typical session looks like this:

```text
query jazz piano
results
info 1
download 1
downloads
```

`query` starts the search.

`results` shows what came back.

`info 1` lets you inspect result 1 before downloading it.

`download 1` creates a background download job.

`downloads` shows its progress.

### Run Several Searches at Once

You don't have to wait for one search to finish before starting another:

```text
query jazz piano
query ambient techno
```

Then:

```text
queries
```

might show searches such as `q1` and `q2`.

To inspect just one of them:

```text
results q1
```

Then download any result using its result number:

```text
info 1
download 1
```

When you're done with a search:

```text
clear q1
```

Or clear all searches:

```text
clear
```

Clearing a search does not cancel downloads that were started from it.

### Browse Everything a Host Is Sharing

Search results tell you which host returned them.

If a result came from:

```text
198.51.100.25:6346
```

you can ask that host for its complete shared library:

```text
browse 198.51.100.25:6346
```

If you're already connected to the host, you can use its short peer ID instead:

```text
peers
browse p1
```

### Remember a Peer

If you know a peer you want Gnutonium to reconnect to later:

```text
connect 203.0.113.10:6346
save
```

The address will be stored in `state.peers` and tried again on future runs.

You normally don't need to maintain a peer list yourself; Gnutonium can discover peers through the normal Gnutella bootstrap process.

### Watch Download Activity Without All the Noise

For general live logs:

```text
monitor on
```

or:

```text
monitor all
```

To focus specifically on downloads:

```text
monitor downloads
```

This shows things such as:

- downloads starting and finishing
- retries
- transfer failures
- download-manager errors

while hiding most peer traffic and handshake noise.

Normal commands still work:

```text
peers
downloads
info d5
```

To turn live logging off:

```text
monitor off
```

Running bare:

```text
monitor
```

toggles monitoring between off and the normal general-monitoring mode.

Your `config.log_ignore` settings still apply.

## Scripted Usage

The interactive CLI is convenient for humans, but commands can also be supplied ahead of time with repeated `--exec` flags.

For example:

```bash
gnutonium run --config gnutella.json \
  --exec 'status' \
  --exec 'query hello world' \
  --exec 'sleep 2' \
  --exec 'results' \
  --exec 'quit'
```

This is useful for smoke tests, demos, and simple automation.

Most interactive commands work through `--exec`, including commands that target individual searches:

```bash
gnutonium run --config gnutella.json \
  --exec 'query jazz piano' \
  --exec 'sleep 2' \
  --exec 'results q1' \
  --exec 'clear q1' \
  --exec 'quit'
```

## Where to Go Next

For the shortest possible path from installation to your first working Gnutella session, read [QUICKSTART.md](QUICKSTART.md).

If you want to embed or control Gnutonium from code rather than through the terminal, read [DEVELOPER.md](DEVELOPER.md).
