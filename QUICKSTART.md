# Quickstart

## 1. Get Gnutonium

You can:

- download a prebuilt binary from the [releases page](https://github.com/RickCarlino/gnutella-bun-client/releases)
- install with `npm install -g gnutonium` (requires Bun 1.4.4 or newer)
- run from source with Bun 1.4.4 or newer

If you are running from source:

```bash
bun install
```

Throughout this guide, commands use the CLI command:

```bash
gnutonium
```

If you are running from source, replace `gnutonium` with:

```bash
bun run bin/gnutonium.ts
```

If you are using a compiled binary, replace `gnutonium` with the executable path.

## 2. Create A Config

```bash
gnutonium init --config gnutella.json
```

This creates a config file, a downloads folder, and an incomplete-downloads folder.

By default, Gnutonium shares files from `./downloads` and moves completed downloads there after any available SHA1 verification. Partial downloads live in `./incomplete` and are resumed across restarts.

## 3. Put Files In Your Share Folder

Copy any files you want to share into `./downloads`.

If you changed `config.data_dir`, use `<data_dir>/downloads` instead.

## 4. Start The Client

```bash
gnutonium run --config gnutella.json
```

Gnutonium automatically finds peers at startup.
To manually connect to a known peer, use `connect <ip:port>` after startup.

Useful first commands:

```text
status
peers
shares
```

## 5. Search For Files

```text
query hello world
results
info 1
```

`results` gives you numbered hits.

`info 1` shows the details for result `1`.

If you want a magnet link for a result:

```text
magnet 1
```

## 6. Browse A Host

If a peer looks interesting, you can browse its whole shared library.

First list your connected peers:

```text
peers
```

Then browse by peer key:

```text
browse p1
```

You can also browse directly by address:

```text
browse 203.0.113.10:6346
```

## 7. Download A Result

Download to the default folder:

```text
download 1
downloads
```

Or pick an explicit destination:

```text
download 1 ./my-copy.bin
```

If the destination file already exists, Gnutonium resumes from the current file size when possible.

Use `pause <jobId>`, `resume <jobId>`, and `remove <jobId>` to manage jobs shown by `downloads`.

## 8. Save And Quit

```text
save
quit
```

`save` writes the current config and remembered peers to disk right away.

## If Something Looks Empty

- No peers yet: give bootstrap a little time, or run `connect <ip:port>` if you already know a live peer.
- No results yet: wait a few seconds after connecting, then try another query.
- Want the full command list and config reference: read [CLI.md](CLI.md).

## Keep Multiple Searches Open

Run another `query` whenever you want to start a new search. Use:

- `results` to see all searches under separate headings.
- `results q1` to see only search `q1`.
- `queries` to list search handles, result counts, and search terms.
- `clear q1` to remove one search and its results.
- `clear` to remove all searches and their results.

Downloads keep running when you clear searches.

## Select Multiple Results and Use Tab

In the interactive prompt, press Tab for commands, current handles, and valid statuses. Download several results or manage jobs together:

```text
download 1,3-5
pause active,queued
downloads paused
resume paused
clear searches q1-q3
clear complete
```

Bare `clear` clears searches only. `clear complete` removes completed download jobs while preserving their files. `clear d1` and `remove d1` both delete the job's incomplete file; completed files remain. Use `clear downloads all` or `clear searches all` instead of ambiguous `clear all`. Lists and ranges also work in `--exec`; see [CLI.md](CLI.md#selecting-multiple-targets) for validation and batch behavior.
