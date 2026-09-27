# Library Embedding Guide

Use this guide if you want to run Gnutonium inside your own TypeScript app instead of driving it through the CLI.

Install with `npm install gnutonium` and run your app with Bun 1.4.2 or newer.

Most apps only need three things:

- `loadDoc()` to load or create a config file
- `GnutellaServent` to run the node
- the public getters and actions on the node instance

## Basic Example

```ts
import { GnutellaServent, loadDoc, type GnutellaEvent } from "gnutonium";

const configPath = "./gnutella.json";
const doc = await loadDoc(configPath);

const node = new GnutellaServent(configPath, doc, {
  onEvent(event: GnutellaEvent) {
    if (event.type === "QUERY_RESULT") {
      console.log(
        `#${event.hit.resultNo} ${event.hit.fileName} from ${event.hit.remoteHost}:${event.hit.remotePort}`,
      );
    }

    if (event.type === "DOWNLOAD_SUCCEEDED") {
      console.log("downloaded to", event.destPath);
    }
  },
});

await node.start();
await node.connectToPeer("203.0.113.10:6346");
node.sendQuery("hello world");
```

When you are done:

```ts
await node.save();
await node.stop();
```

## Loading And Saving State

```ts
import { loadDoc } from "gnutonium";

const doc = await loadDoc("./gnutella.json");
```

`loadDoc()` creates a default config if the file does not exist yet.

The config file uses the same settings as the CLI, so anything you learn in [CLI.md](CLI.md) also applies here.

Call `node.save()` when you want to persist remembered peers, blocked IPs, and other changes immediately.

## Starting A Node

```ts
const node = new GnutellaServent("./gnutella.json", doc);
await node.start();
```

`start()` loads shares, starts listening, and begins normal background work such as peer reconnects.

Automatic discovery forgets failed endpoints and skips them for the rest of the session.

Call `stop()` for a clean shutdown:

```ts
await node.stop();
```

## Listening For Events

You can subscribe in the constructor with `onEvent`, or later with `subscribe()`. The latter returns an unsubscribe function:

```ts
const unsubscribe = node.subscribe((event) => {
  if (event.type === "DOWNLOAD_QUEUED") {
    console.log(event.jobId, event.fileName);
  }
});

// When this part of your application is disposed:
unsubscribe();
```

Events form the discriminated `GnutellaEvent` union; checking `event.type` narrows its fields. Listeners run synchronously, so keep callbacks brief and handle failures from any asynchronous work you start inside them.

Useful events for most apps:

- `QUERY_RESULT`: a search hit arrived
- `DOWNLOAD_QUEUED`: a managed download job was created or updated
- `DOWNLOAD_STARTED`: a managed download started transferring
- `DOWNLOAD_SUCCEEDED`: a download finished
- `DOWNLOAD_FAILED`: a managed download exhausted its sources
- `DOWNLOAD_VERIFICATION_FAILED`: SHA1 verification failed
- `PEER_CONNECTED`: a peer connected
- `PEER_DROPPED`: a peer disconnected
- `SHARES_REFRESHED`: the share list changed
- `MAINTENANCE_ERROR`: background work failed

## Common Node Actions

### Connect To A Peer

```ts
await node.connectToPeer("203.0.113.10:6346");
```

### Search

Keep the returned ID to read results from a particular search:

```ts
const music = node.sendQuery("ambient techno");
const books = node.sendQuery("distributed systems");
console.log(node.getSearches());
```

Each returned `SearchSession` has a full `id`, a display `number`, a status, and a result count. Pass the full `id` to library methods; CLI handles such as `q1` and selector expressions are not library arguments.

Results may take a few seconds to arrive. Read them when needed:

```ts
if (music) console.log(node.getResults(music.id));
if (books) console.log(node.getResults(books.id));
```

If no peers are connected, `sendQuery()` returns `undefined`. Connect to a
peer and try again.

### Clear Searches

```ts
if (music) node.clearResults(music.id); // Remove this search and its results.
node.clearResults(); // Remove all searches and their results.
```

Downloads keep running when you clear searches.

### Browse A Peer

Browse a connected peer by key, then read its file listing:

```ts
const listing = await node.browsePeer("p1");
console.log(node.getResults(listing.id));
```

You can also browse an address directly:

```ts
const listing = await node.browsePeer("203.0.113.10:6346");
console.log(node.getResults(listing.id));
```

### Download A Result

```ts
const job = await node.downloadResult(1);
console.log(job.id, job.status);
```

Or choose the destination path yourself:

```ts
const job = await node.downloadResult(1, "./downloads/example.bin");
```

`downloadResult()` creates or updates a persisted background job and returns
immediately. Use `getDownloadJobs()` to inspect progress, `pauseDownload(id)`
to pause, `resumeDownload(id)` to requeue a paused or failed job, and
`removeDownload(id)` to forget a job and delete its incomplete file. Completed files are preserved. Clearing searches never cancels jobs that were started from their results.

Job statuses are `queued`, `active`, `paused`, `verifying`, `complete`, `failed`, and `verification_failed`. `failed` and `verification_failed` are separate states. Pausing or resuming a completed job leaves it complete. Jobs and incomplete files survive restarts; `start()` resumes the scheduler's background work.

The library actions accept one job ID at a time. To operate on a selected group, take a snapshot and call the public action for each job:

```ts
const paused = node
  .getDownloadJobs()
  .filter((job) => job.status === "paused");
for (const job of paused) {
  try {
    await node.resumeDownload(job.id);
  } catch (error) {
    console.error(`Could not resume ${job.id}`, error);
  }
}
```

The download scheduler controls transfer concurrency independently of these calls.

### Refresh Shared Files

```ts
await node.refreshShares();
```

Use this after your app adds or removes files from the shared downloads folder.

## Reading Runtime State

These getters are the ones most apps care about:

- `getStatus()`: summary counts
- `getPeers()`: connected peers
- `getKnownPeers()`: remembered peer addresses
- `getShares()`: local shared files
- `getSearches()`: your searches and result counts
- `getResults(searchId)`: results from one search
- `getResult(resultNo)`: details for a result number
- `getDownloadJobs()`: persisted managed download jobs
- `getDownloads()`: completed download history for the current process

Example:

```ts
const status = node.getStatus();
const peers = node.getPeers();
const searches = node.getSearches();
const results = searches[0] ? node.getResults(searches[0].id) : [];
const downloads = node.getDownloadJobs();
```

## Runtime Overrides

If you want to change behavior at startup without editing the JSON file first, pass `runtimeConfig` to the constructor:

```ts
const node = new GnutellaServent(configPath, doc, {
  runtimeConfig: {
    ultrapeer: true,
    gwebCaches: {
      entries: {
        "https://cache.example.com/gwc.php": {
          status: "candidate",
          discoveredAt: 0,
        },
      },
    },
  },
});
```

This is useful when you want one app-specific setup while still keeping the same saved config format. Constructor options and public API settings use camelCase; the JSON file uses the names documented in [CLI.md](CLI.md#configuration).

`config()` returns a detached snapshot. Use `updateRuntimeConfig()` to change settings, and `save()` to persist supported configuration fields:

```ts
node.updateRuntimeConfig({ downloadQueueSize: 3 });
await node.save();
```

Collection getters likewise return snapshots. Changing a returned job or peer object does not control the running engine; use its public actions.

## A Good Default Pattern

For most embedding cases, this flow works well:

1. `loadDoc()`
2. `new GnutellaServent(...)`
3. attach an event listener
4. `start()`
5. `connectToPeer(...)` or rely on remembered peers
6. `sendQuery(...)` or `browsePeer(...)`
7. inspect `getResults(search.id)`
8. `downloadResult(...)` when needed, then inspect `getDownloadJobs()`
9. `save()` and `stop()` on shutdown

## Next Step

If you are mainly using the terminal, read [CLI.md](CLI.md) instead.

## Migrating to 2.0

The documented actions, package export paths, event shapes, and saved-data
formats remain supported. Undocumented mutable fields and low-level node
methods have been removed from the public facade. Use the public getters
and actions instead. `config()` and collection getters return snapshots;
change settings with `updateRuntimeConfig(patch)`, then `save()` to persist.
The constructor also takes its own copy of the supplied config document.
Existing config files, share indexes, jobs, and partial downloads need no
conversion. Bun 1.4.2 is required for public server-side TLS socket upgrades.
