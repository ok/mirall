# Mirall — Solution Architecture

> **Scope.** Authoritative for: process model, data model, networking, IPC catalog, update mechanics, security model.
> **Not authoritative for** (cited, never duplicated): `build-process.md` — release/CI/seed-host pipeline · `design.md` — visual language, component styling · `testing.md` — test layers + a11y discipline · `dependency-updates.md` — dep-bump playbook · `package.json` — dependency versions.
> Section numbers are stable: `README.md`, `CONTRIBUTING.md`, `build-process.md`, and code comments cite them.

## 1. Overview

A peer-to-peer file-sharing desktop app on the **pear-electron-runtime** architecture: an Electron host embedding [`pear-runtime`](https://github.com/holepunchto/pear-runtime) as a library, plus a Bare worker holding the P2P data layer. Users create a profile, organize into **spaces** (collaborative topics), and share files directly between peers — no servers.

Two sharing modes coexist inside a space:

1. **Loose files** — never synced automatically. Peers see a catalog of everything available in the space and explicitly choose what to download. The UI reflects a canonical file-state model (§3.5).
2. **Shared folders (owned folders)** — a whole local directory tree published as a *share*. The owner mounts a disk folder and a `chokidar` watcher keeps the share's catalog in sync with disk. Any peer may **mirror** the share to a local folder of their choosing (a *foreign mount*), and the worker continuously materializes the owner's files there. Unlike loose files these *do* sync continuously — but only after the owner opts in (mount) and the peer opts in (mirror). §7.

`listFiles` filters share-prefixed paths out of the loose catalog, so each file appears in exactly one place.

§16 is the identity & security model. §17 is the glossary — every domain term is defined there once and used undefined thereafter.

### How it ships

- **Local dev** — `npm start` (Electron + worker, OTA disabled). `npm start -- --updates` exercises the OTA flow. `npm run dev` = esbuild + Tailwind watch + a local HTTP server for `assets/`.
- **Installers** — `.dmg` (macOS), `.msix` (Windows), `.AppImage` (Linux). → `build-process.md`.
- **OTA** — the installed app subscribes to a per-channel Pear Hyperdrive. When the drive head advances past the running version, the app mirrors the new bundle and atomically swaps it in. §9.
- **Seed host** — Arch Linux VM running `mirall-seed.service`, a systemd unit that runs `pear seed production` continuously. Operators publish with `seed-host/scripts/release.sh`. → `build-process.md`.

### Release channels

Three release lines, each its own Pear Hyperdrive with its own `pear://` upgrade key (stored in CI secrets and the seed host's `~/.config/mirall/upgrade-keys.json`).

| Channel | Trigger | Audience | Snapshot |
|---|---|---|---|
| `dev` | `workflow_dispatch` | internal devs | no |
| `staging` | `workflow_dispatch` | wider stakeholders | no |
| `prod` | `v*` tag push, or `workflow_dispatch` with channel=prod | end users | yes — Hetzner VM snapshot via `release.sh` |

Bundle version **===** the drive's `/package.json#version`. That equality is what makes the OTA banner fire only when a genuinely newer release exists. → `build-process.md` "Version coupling".

### Stack

Roles only; `package.json` is authoritative for versions, and §12 records the few non-obvious constraints.

| Component | Role |
|---|---|
| Electron | Host process, BrowserWindow, IPC bridge |
| `pear-runtime` | Embedded library — OTA updater, drive replication, `pear.run(entrypoint)` worker spawn |
| `pear-runtime-updater` | Watches the channel drive, mirrors bundles, applies them |
| Corestore, Hyperbee, Hyperdrive, Hyperswarm, Protomux | The Holepunch stack — defined in §17 |
| `chokidar` | Recursive FS watcher for shares. **Electron main only** — Bare has no native recursive watch |
| `hypercore-storage` | Low-level RocksDB keys used by `purgeCoreDk()` |
| `compact-encoding` / `b4a` | Handshake wire encoding / Bare-compatible Buffer utils |
| `sodium-native` / `hypercore-crypto` | Cryptographic primitives / random bytes + key generation |
| `which-runtime` | Detects Bare vs Node vs Electron, plus platform/arch |
| `bare-fs` `-path` `-os` `-subprocess` `-https` | Bare stdlib, worker only |
| React 19, React Aria (+ `@react-stately/*` state containers), Tailwind v4 | Renderer (TypeScript) — see `design.md` |
| `modern-screenshot` | Screenshot capture for the feedback payload |

---

## 2. Process Architecture

Three processes. **Main** owns lifecycle, the BrowserWindow, and all access to `pear.updater` / OS APIs. The **renderer** is sandboxed and reaches main only through a contextBridge. The **worker** is a Bare child process holding all P2P / filesystem / network logic; it talks to the renderer through main, which forwards IPC frames both ways.

```
┌────────────────────────────────┐  contextBridge   ┌────────────────────────────────┐
│   ELECTRON MAIN                │ ◄──────────────► │   ELECTRON RENDERER            │
│   src/main/main.js             │  (window.bridge) │   src/renderer → assets/dist   │
│                                │                  │                                │
│  PearRuntime (library)         │                  │  React 19 + Tailwind           │
│  ├─ updater (channel drive)    │                  │  ├─ Onboarding / Shared Spaces │
│  ├─ run(workerPath) → Bare     │                  │  ├─ Space View / Folder View   │
│  └─ external Corestore + swarm │                  │  ├─ Settings family / Storage  │
│  IPC handlers (pear:*, …)      │                  │  └─ About / Feedback           │
│  notifications.js              │                  │                                │
│  owned-folder-watchers.js      │                  │  src/renderer/ipc.ts           │
│  loose-file-watchers.js        │                  │  └─ window.bridge.*            │
│   └─ chokidar → fs-event       │                  │                                │
└────────────────────────────────┘                  └────────────────────────────────┘
            │           ▲                                        ▲
            │ NDJSON    │ event:owned-folder-fs-event            │ pear:worker:ipc / stdout / exit
            ▼           │                                        │
┌────────────────────────────────────────────────┐               │
│   BARE WORKER  src/worker/main.js              │ ──────────────┘
│                                                │
│   shared/core/store.js → Corestore             │
│   ├── profile bee (+ share/… records)          │
│   ├── spaces-meta / downloads-meta             │
│   ├── pending-transfers / mounts-meta          │
│   └── per-space drives (identity only)         │
│                                                │
│   swarm.js         → Hyperswarm + Protomux     │
│   backends/overlay → content backend           │
│   files.js  shares/*  folders/*  storage.js    │
└────────────────────────────────────────────────┘
                        │
                        ▼
                   ┌────────┐
                   │ PEERS  │  Corestore replication +
                   └────────┘  mirall/handshake channel
```

### Main process (`src/main/main.js`)

1. **Argv** via `paparam` — `--storage <dir>` (custom data dir; also redirects Electron's `userData`), `--no-updates`, `--menu` (force-show menu on Win/Linux for DevTools), `--no-sandbox` (declared so paparam doesn't bail when AppRun forwards it on Linux).
2. **`PearRuntime` construction** with an externally-built `Corestore` + `Hyperswarm`, so we control replication and topic-join behaviour. The `version` passed in is the bundled `package.json`'s, which CI patches at build time.
3. **Updater wiring** — when `updates !== false`: join the upgrade drive's discovery key as a swarm client, replicate incoming connections into the Corestore, listen for `pear.updater.on('updating'|'updated')`, forward to the renderer as `pear:event:*`.
4. **Worker spawn** via `pear.run(entrypoint, [])`. `getWorker(specifier)` is idempotent (cached in `workers: Map`), bootstraps the worker with a JSON line `{ storage, appVersion, dev, fork, length, verbose }`, and bridges: `pear:worker:writeIPC:<spec>` (renderer→worker NDJSON to stdin; try/catched to swallow shutdown-race EPIPE/FIN), `pear:worker:ipc:<spec>` (worker→renderer), and `pear:worker:stdout/stderr/exit:<spec>`.
5. **BrowserWindow** with `preload: src/preload/preload.js`, `sandbox: true`, `contextIsolation: true`. All app config (window bounds + zoom, theme, general prefs, download folder, on-demand cache budget, renderer-only UI prefs) lives in one `getDataDir()/config.json`, owned exclusively by main via `ConfigStore` (`src/main/config-store.js`): atomic writes (tmp→fsync→rename), merge-over-defaults on read, a `version` migration seam, and a one-time fold of the pre-unification per-setting files (`zoom/window-bounds/theme/app-prefs/download-settings.json`, the worker's `ondemand-cache.json`) plus the renderer's `localStorage` keys (originals deleted only after the unified file is durably written). Bounds are read on launch, written debounced on resize/move.
6. **DevTools shortcut** — `webContents.before-input-event` toggles DevTools on F12 / Ctrl-Shift-I (Win/Linux) or Cmd-Opt-I (mac). Needed because the menu is hidden on Win/Linux by default.
7. **Update apply** — automatic, no user action. Windows/Linux pre-stage the swap in the background as soon as the updater reports `updated`; macOS defers to quit. A `before-quit` hook promotes any staged-but-unapplied bundle. §9.
8. **Diagnostic IPC** — `pear:checkForUpdate` → `pear.updater._debouncedUpdate()`, reports `{length, fork}`. `pear:appVersion` reads the live drive head's `package.json#version`. Both feed the renderer's update flow (§8).
9. **Native notifications & shell** (`src/main/notifications.js`) — `notify:show` builds an Electron `Notification` (per-platform fallback icon under `resources/{darwin/icon.icns,win32/icon.ico,linux/icon.png}`); `notify:isWindowFocused` lets the renderer suppress notifications when focused; `notify:focus` raises the window on click; `shell:showInFolder` reveals a path, **gated to `os.homedir()` plus the download roots the worker publishes** (`downloads:roots`, which carries the per-space overrides) so the renderer can't poke arbitrary disk locations.
10. **Asar spawn shim** — when the bundle is asar-packed (§13), `child_process.spawn` is monkey-patched to rewrite `app.asar/` → `app.asar.unpacked/` in both the executable path and argv. Without it `bare-sidecar`'s `spawn(bareBinary, [workerEntry, …])` ENOTDIRs, because `require.resolve()` returns asar paths and the OS can't walk into the archive. No-op outside packaged builds.
11. **Custom protocol** — `app.setAsDefaultProtocolClient('mirall')` registers `mirall://` on macOS/Windows; `app.requestSingleInstanceLock()` makes repeat launches focus the running instance. Three paths funnel into `dispatchDeepLink()`: macOS `open-url`, Win/Linux `second-instance` (warm), and a direct argv scan at boot (cold-start URLs are positional, so paparam can't help). `parseDeepLink` (`src/main/deeplink.js`) validates and returns `{kind:'join', code, name?}`; main forwards on the `deeplink` channel, queueing in `pendingDeepLinks[]` until the renderer calls `deeplink:flush`. Linux AppImage installs additionally rewrite `~/.local/share/applications/Mirall.desktop` at launch (`integrateXdgLinux`) to declare the MimeType and an absolute `Exec=`, so xdg-mime can route URLs to a possibly-moved AppImage. §5.2.
12. **Filesystem watchers** — `chokidar` lives in Electron main, never in the worker, because Bare has no native recursive watch.
    - `src/main/owned-folder-watchers.js` — per-share recursive watchers. The worker asks main to `owned-folder:start-watcher` / `stop-watcher` (also exposed to the renderer via `bridge.startOwnedFolderWatcher`). `startWatcher(shareId, mountPath, ignore, …)` sets `ignoreInitial: true`, `awaitWriteFinish` (debounced), `followSymlinks: false`, and switches to polling for network-looking paths (`/Volumes/`, `/mnt/`, SMB/NFS). Each `add`/`change`/`unlink` is forwarded to the worker as `event:owned-folder-fs-event { shareId, action, relPath, absPath }`. An error-burst guard stops a watcher that throws ≥5 times in 10 s; `stopAllWatchers()` runs on `before-quit`.
    - `src/main/loose-file-watchers.js` — watches individual absolute paths for in-place loose-file shares, fanning each event out to every space watching that path.

Main holds **no** application state — no profile, no spaces, no transfers. It is a bridge between OS / pear-runtime / OTA / the filesystem watchers on one side and the renderer + worker on the other.

### Renderer (`src/renderer/` → `assets/dist/`)

React 19, typechecked by `tsc --noEmit`, bundled by esbuild. Loaded via `assets/index.html`.

`src/renderer/ipc.ts` wraps the worker bridge into a request/response API:

```ts
await request('files:list', { spaceId })   // Promise<FileEntry[]>
const off = subscribe('event:files-updated', ({ spaceId }) => …)
```

It calls `window.bridge.startWorker('/src/worker/main.js')` once on mount; outgoing requests serialize to NDJSON with an `id`; incoming frames dispatch to pending resolvers (matched by `id`) or to event subscribers.

`src/renderer/updates.ts` (singleton) subscribes to `bridge.onPearEvent('updated')` and exposes staged-update state to React (`UpdateBanner` + `useUpdates`). On `updated` it reads the staged version via `bridge.appVersion()`; dev builds simply reload the window. The banner is passive — the update applies in the background or at quit (§9). Dismiss only hides the banner; the About screen keeps showing the notice.

### Worker (`src/worker/main.js` entry + `src/worker/boot.js` root)

Bare process spawned by `pear.run('/src/worker/main.js')`. ESM (`src/worker/package.json` has `"type": "module"`). Registers IPC handlers with `src/shared/core/ipc.js`'s NDJSON router.

The process is split in two. **`worker/main.js` is the entry**: the crash backstop, the IPC pipe and its close hooks, the bootstrap frame, the membership-control block, every `domain:verb` handler, the shutdown deadline and `Bare.exit`. **`worker/boot.js` is the composition root**: it constructs every subsystem with its collaborators passed in, starts them in a declared order, and returns a root whose `close()` closes them in the reverse of that order. `boot()` and `close()` never exit the process, which is what makes an in-process restart testable.

Bootstrap:

1. `createIPC(Bare.IPC)` — buffered NDJSON router on the stdio pipe.
2. `installCrashBackstop(log)` — **before the first `await`**, so no boot-time rejection can abort the worker.
3. `getBootstrapPromise()` blocks for the first `{type:'bootstrap'}` line `{ storage, appVersion, dev, fork, length, verbose }`; `setRuntimeConfig(bootstrap)`.
4. `root = await boot(bootstrap, { ipc, log, membershipControl, publishDownloadRoots })`, which starts **two lifecycle tiers**. The **durable** tier (`bootDurable()`, exported from the same file) holds everything that must outlive the network teardown — every handle on a Corestore session, plus the recorder the teardown writes through — and is closed **last**:
   1. `Store` → identity unlock → `migrateLocalBeesToEncrypted` → `SpaceKeysVault` → `ProfileBee` → `SpacesBee` → `DownloadsBee` → `PendingTransfersBee` → `MountsBee` → `IntentsBee`.
   2. `AuditLog` (bee + connectivity watch) — started before the drives, so the log is writable before anything worth recording happens. A failed start degrades to no rows; it never aborts boot.
   3. `ServeLedger`, immediately after `AuditLog` so that on the way out it flushes **before** that bee closes and while the spaces bee it reads is still open.
   4. `Catalogs` (the own/peer catalog bee caches) → `SpaceDrives` (`loadDrives`; on failure, `cleanupOrphanedData()`) → the three manifest caps → the one-time content migrations.

   The **runtime** tier is closed first, in reverse of this order:
   5. `MountsRuntime` is **constructed** (side-effect-free) so `OwnedFolders` can take its settle callback; then `OverlayBackend` (the overlay instance, the serve index and both download engines — constructed here rather than at module level, which is what keeps the package's import cycle free of construction), `PublishService`, `OwnedFolders`, `ForeignMirrors`, `EchoGuardPurge` and `PeerWatch` start. `ForeignMirrors` installs `setOverlayCatalogChangeHook(onPeerDriveChanged)` so a peer-catalog append promptly nudges the relevant mirror loops.
   6. Interrupted-leave resume, then `intents.recover()` — the durable intent log's boot pass (§ below) — then download-root hydration and the membership backfill. Recovery runs after every reconciler has registered and before the swarm, so a topic join cannot re-arm a watcher against a space the pass is about to forget.
   7. `MemberViews` — **before** the swarms, because starting it is what wires the member registry's collaborators, and a handshake that landed while they were still the no-op defaults would read every peer as disconnected. It is also necessarily before the topic joins, so an inbound membership request cannot be handled with an unseeded tombstone set.
   8. `Swarm`, then `ContentSwarm` (which needs the control swarm's DHT node), then `applyRelayConfig()` — a relay installed on the control swarm alone leaves every file byte unrelayed. Every hook the swarm fires is a **constructor dep** (`membershipControl`, `overlayBackend`, `stalledOwners`) declared with `require()`, so a missing one fails at boot with the subsystem's name instead of being a `hook?.()` that never fires. Then the crash-leftover sweeps, the topic joins and the pending-leave replay.
   9. `MountsRuntime` **starts**: resume every owned and foreign mount, then arm the 60 s mount probe — it re-checks every mount's disk path so USB unmounts / network drops flip a share to `mount-point-gone`, and a re-appearance restarts the watcher/loop. Then `Sweeps` (presence, invite expiry, audit prune) last.

5. Register IPC handlers, then `ipc.start()` flushes requests that arrived before handlers existed.
6. Emit `event:state` (profile + spaces) — or `event:profile-needed` if onboarding hasn't happened — then `event:worker-ready`.

Shutdown is driven by `Bare.IPC.on('end'|'close'|'error')` → `safeShutdown()` → `root.close()` under a 4 s hard deadline, then `Bare.exit(0)`. `close()` announces departure and halts publishing first (deliberately not in reverse order — the datagram has to leave UDX before any socket drops), waits a 150 ms flush window (**ref'd**: it is the one await on the path with no work behind it, and an unref'd timer there empties the loop for an in-process caller holding no other handle), then closes the runtime tier in reverse — there is no hand-ordered tail left — and **last** the durable tier — whose `Store._close` warns, naming any Corestore session still open, because that list is precisely the handles nobody owned. Tearing the network down is itself what emits `serve.completed` rows, which is why the ledger and the audit bee are in the tier that closes after it. In-flight downloads need no suspend step: the durable pending rows (§3.4) reconstruct resume state next run.

**Durable intents.** A multi-step flow whose steps span stores writes `intent/<kind>/<id>` to the
intents bee as its FIRST durable act and deletes it as its LAST (`core/intents.js`); a reconciler
registered against that kind completes it idempotently at the next boot. Recording is best-effort —
a flow that cannot write its intent still runs, losing only the recovery net, because refusing the
user's action over a bookkeeping write would be the worse outcome. A reconciler that throws keeps
its record for the next boot; an intent whose kind is unknown is left untouched, so a downgrade
cannot eat a newer build's pending work. Converted so far: `owned-delete`, `foreign-unmount`.
`space:leave` keeps its own `space.leaving` marker (load-bearing in the boot filter and the member
fold) but shares the teardown ORDER with the boot pass through `spaces/leave-flow.js`, which is what
the two used to encode independently and drift on.

**Bounded by construction.** Three caps the review's scale findings asked for, each with a `0`
rollback: `downloadConcurrency` (3) admits fetches through a FIFO semaphore with one express lane
for user-initiated downloads, so a reconnect backlog cannot spawn one chunk scheduler, watchdog, fd
and ticker per pending row; `peerFrameBurst`/`peerFrameMaxBytes` meter and size-cap EVERY peer frame
before the decode, not just the two identity types; `peerCatalogCacheLimit` (64) bounds the open
peer-catalog set with a refcounted LRU — watchers and in-flight reads pin their entry, because the
cached values are live handles and `onEvict` closes them.

**The contract package.** `src/shared/contract/` is the vocabulary all three runtimes speak:
request names and their argument shapes (`requests.js`), error codes (`errors.js`), event names,
limits, status tuples, the reconcile `Scope`, and the audit kinds. **Plain ESM with zero imports** —
that constraint is what lets esbuild bundle it into the renderer, Bare load it in the worker and
main reach it through `import()`, and it is test-enforced. The renderer's hand-maintained twins
(`scope-match.js`, and the kind list inside `auditKinds.ts`) are gone; `scope.ts` and `auditKinds.ts`
remain as import paths that re-export. `.js` + `.d.ts` rather than `.ts` because the unit suite runs
under brittle-node with no build step — and because TypeScript never compares the two,
`contract-declarations.test.js` does, including the status tuples the renderer derives its unions
from.

**The handler table.** `core/handler-table.js` holds each request's function beside its contract
spec. `ipc.handle(name, fn)` is now a shim onto `table.register`, so registering a name the contract
does not declare **throws at boot** rather than surfacing as a field 404, and the router validates
every payload against the declared arg shape before the handler runs — replacing the four
`typeof msg.` checks that were spread across 85 handlers. A bad payload is refused with
`INVALID_ARGUMENT` and counted. Only `spaceId` and `shareId` are required; everything else is
type-checked when present but never demanded, so the gate cannot reject traffic a caller already
sends. `createIPC(pipe, { requests })` lets a test declare the small vocabulary it exercises.

**Two import-time rules**, both test-enforced, because anything a module does at import is beyond every `close()`:

- **No module-level timers.** Arm periodic work in a `Subsystem._open` through `this.timers`, so it dies with the subsystem. Enforced by an eslint `no-restricted-syntax` selector on the data-layer block (`moduleLevelTimerRestrictions`), driven through eslint's own parser by `test/unit/module-level-timers.test.js`.
- **No module-level construction that arms a resource, and none inside an import cycle.** The static rule cannot see a `const x = createFoo()` whose body arms a timer, nor a TDZ. `test/integration/import-time.test.js` covers both: importing every `src/shared` module behind a timer shim must create zero timers, and each member of the known import cycle must be importable *first* in a fresh Bare process.

---

## 3. Data Model

All persistent state lives in one **Corestore** at `Pear.config.storage` (the worker bootstrap's `storage`, i.e. main's `getDataDir()`). `src/shared/core/store.js` exposes `initStore()`, `getStore()`, `createBee(name)`, `createDrive(name)`. Lifetimes are owned, not shared: `Store` owns the Corestore, and each bee's module owns its bee (`ProfileBee`, `SpacesBee`, `DownloadsBee`, `PendingTransfersBee`, `MountsBee`, `SpaceDrives`, `Catalogs`) — closing the store would close every session anyway, but a Hyperbee or Hyperdrive whose store closed underneath still reports `closed === false`, so a handle must be closed by its owner rather than probed by whoever cached it.

Every bee below uses **utf-8 keys, JSON values**.

### 3.1 Profile bee (`profile`) — replicated

| Key | Value | Notes |
|---|---|---|
| `displayName` | `"Alice"` | Required |
| `avatar` | `"data:image/jpeg;base64,…"` | Optional; resized to 160×160 JPEG client-side (`renderer/utils.ts::resizeAvatar`) |
| `publicKey` | `"ab3f…"` | Hex of the profile core's public key — **this is the peer identity** |
| `caps/<name>` | `true` | Capability flag — see below |
| `member/<spaceId>` | `{ active: true, ts }` | Per-space membership manifest. Presence ⇒ active; absence ⇒ left. Read by peers during reconciliation (`readPeerMembership`). Gated by `caps/membership-manifest` |
| `observed/<peerKey>/<spaceId>` | `{ ts }` | Witness observation, written when this peer observes another leave. A backup evidence source for receivers who were offline at leave-time. Gated by `caps/leave-observations` |
| `share/<spaceId>/<shareId>` | `{ id, type:'owned-folder', name, owner, createdAt, deletedAt? }` | A folder share this user owns. Replicates via the profile bee — that's how peers discover shares. Deletion is a **tombstone** (row kept) so peers distinguish "owner removed it" from "never replicated". Gated by `caps/folder-shares`. §7 |

Peers read each other's avatars and manifests through `withPeerBee()`, which opens the remote profile bee by that key, pulls its head, runs the read and **closes the session** — one bounded read, one budget covering both phases, and a session-level timeout so an abandoned read cannot pin the core through a hung batch. Exactly one bee per peer is held open for the process: the holder carrying the `append` listener that drives admission re-evaluation, the share-list refresh and the audit observer. (Before this, every transient read opened a session that was never closed, so nothing was ever reclaimed and every leaked core stayed attached to every replication stream.) Reads are bounded by a 10 s budget for avatars and 1.5 s for the membership read.

#### Capability flags

Any P2P feature that must distinguish "this peer doesn't publish X" from "this peer left / disabled X" uses a named flag in the profile bee, **never** the app version.

| Aspect | Rule |
|---|---|
| Shape | `caps/<feature-name>` = `true` |
| Read | Absence ⇒ peer doesn't publish this feature ⇒ treat related data absences as **unknown**, not negative |
| Write order | The flag is written **before** the feature's data keys (`ensureMembershipManifestCap` precedes the `member/<spaceId>` put) |
| Removal | Drop the flag; never reuse it for an incompatible meaning — add a new one |

**Why flags, not a version number:** independent features ship at different cadences; a single `manifest/version` couples them, a fork can support one without the other, and removing a feature from a version field is awkward. Flags decouple this and self-document at the storage layer — the pattern of HTTP `Upgrade`, IRCv3 `CAP`, OAuth scopes.

**When to skip:** if absence of the data is already unambiguous (avatar ⇒ "no avatar set"), no flag is needed.

Defined today: `caps/membership-manifest`, `caps/leave-observations`, `caps/folder-shares`.

### 3.2 Spaces bee (`spaces-meta`) — local only, never replicated

| Key | Value |
|---|---|
| `space/<id>` | `{ name, icon, topic, created, members, favorite?, leaving?, downloadFolder?, driveLoadError? }` |

`driveLoadError: { message, at }` is stamped when the space's drive could not be opened at boot and cleared on the next successful load (§4.6).

`id` = first 16 hex chars of the topic. `icon` = Material Symbols name. `topic` = 32-byte Hyperswarm discovery topic (hex). `members` = `[{ publicKey, driveKey, displayName, avatar? }]`.

The user's own drive key is **not stored** — it derives from `store.namespace('space-drive-<spaceId>-<driveSuffix>')`. `driveSuffix` (random 8-byte hex) is generated on `createSpace`/`joinSpace` and persisted on the record. It is stable across restarts but **re-rolls on rejoin after leave**, because `purgeSpace` deletes the record: fresh suffix → fresh keypair → fresh `driveKey`, so peers see a rejoiner as a new drive identity with empty contents. That sidesteps "stale blocks resurrect on deterministic-key reuse". Records predating `driveSuffix` fall back to the unsuffixed name, so existing installs keep working.

### 3.3 Downloads bee (`downloads-meta`) — local only

`<spaceId>:<filePath>` → `{ downloadedAt, localPath, hash }` — `localPath` is the ACTUAL landed
path (a collision-avoiding download may not sit at `<root>/<basename>`). The same bee also holds
`verified:<spaceId>:<shareId>|<relPath>` → `{ hash, at }` and `src:<spaceId>:<filePath>` →
`{ sourcePath, addedAt }` (where a file you OWN lives, for reveal). Survives restarts; cleared
per-space on leave (`cleanupDownloadHistory`).

A file counts as `downloaded` iff the bee has an entry, the recorded path exists on disk, the
recorded hash still matches the advertised content, **and** the path is inside the space's current
download folder. The first two prune the claim on failure; the scope check does **not** — a copy
outside the current folder reports not-downloaded while the claim survives, so re-pointing the space
at the old folder restores it. Download roots resolve through `shared/core/paths.js`:
per-space override (from `space/<id>.downloadFolder`) → the global root → the OS downloads folder.

### 3.4 Pending-transfers bee (`pending-transfers`) — local only

`<spaceId>:<filePath>` → `{ total, inPlace, ownerKey, finalPath, shareId, relPath, bytesTransferred, updatedAt, errorCode?, erroredAt? }`

Writes to one row are serialized per key (`createKeyedLock`), so the progress ticker cannot overtake a status write — a tick issued after an error verdict can no longer read the row before the verdict and put it back without one.

`finalPath` is the real landing path in the download folder (collision-avoided, §3.5); `<finalPath>.mirall.part` and the resume journal derive from it. A row represents an in-flight or interrupted download. The progress ticker persists `bytesTransferred` here so we can derive the UI status (`paused-interrupted` / `paused-offline` / `error`) without the active transfer, auto-resume when the owner returns (§4.5), and show partial progress after restart.

Rows clear on completion (`clearPending`), cancel, `files:discard-partial`, and space leave.

### 3.5 Per-space Hyperdrive — identity only

Created via `store.namespace('space-drive-<spaceId>-<driveSuffix>')` → `new Hyperdrive(...)`.

**The drive carries no file bytes.** Its `driveKey` is the member's per-space identity: the handshake binding signs `noise||driveKey` (§16) and members are matched by it. `listFiles` reads the local drive solely for that key; `files:add` only checks it exists.

**No peer drives are opened.** Peers' loose/folder metadata comes from their replicated, SCK-encrypted catalogs (§3.7), opened lazily per catalog key and cached (`peerCatalogs` in `share-catalog.js`), read **in parallel**, each under **one** interactive NETWORK budget covering head sync and drain together (a spent budget degrades the drain to a local-only read, bounded by a short guard that is reported as an incomplete read rather than as fewer files), so a listing costs about one budget however many members are unreachable. File bytes travel only through the overlay backend (§7.7), addressed by content hash.

#### Canonical file-state model

`src/shared/transfer/files.js` derives every loose file's status from five signals: own/peer catalog entries, the Downloads bee (**re-verified against disk on every list** — disk is the truth, stale claims are pruned), the pending-transfers row, live presence (`isOwnerOnline`), and live engine state.

| Status | Meaning | Signals |
|---|---|---|
| `mine` | Local file I shared, in place | Own catalog entry with a content hash |
| `publishing` | Own file still being hashed | Own catalog entry without a hash + active publish |
| `preparing` | Peer's file still being hashed by its owner | Peer catalog entry without a content hash |
| `downloaded` | Peer file, fully on disk | Downloads-bee claim, verified against disk |
| `downloading` | Active fetch in progress | Live engine state |
| `paused-interrupted` | Fetch interrupted, owner online | Pending row (no `errorCode`) + owner online |
| `paused-offline` | Paused because the owner went away | Pending row + owner offline |
| `remote` | Peer file, owner online, no local data | Peer catalog entry, no pending row |
| `unavailable` | Peer file, owner offline, no local data | Peer catalog entry + owner offline |
| `error` | Fetch failed | Pending row with `errorCode` |

`verifying` also exists in the renderer's `FileStatus` union, surfaced from the `event:decoration` `phase` (§8) rather than derived by the resolver.

Duplicates collapse per **content hash** (`dedupeByHash`): the most-progressed candidate wins by `STATUS_PRIORITY` (`mine` > `downloaded` > `downloading`/`publishing` > `paused-*` > `remote` > `unavailable` > `error`) and the rest fold into a `sharedByCount`.

#### Sharing a file (in-place publish)

Nothing is copied, and nothing is chunked over IPC. The renderer resolves a dropped browser `File` to its real path via `webUtils.getPathForFile(file)` (exposed as `bridge.getPathForFile`) and hands the path to `files:add` (timeout `0`); `loose-overlay.js` registers it **in place**:

1. **Vet the source** (`assertSharableSource`) — must be a real, non-empty file. macOS promised-file temp paths are refused, so a share never points at a path that vanishes.
2. **Admit** under the space lock: resolve the name against the loose catalog *and* the names already queued (collision → free-name suffix; cap `MAX_LOOSE_FILES_PER_SPACE = 100`), record the source path durably, and **enqueue** an `INTERACTIVE` item on the publish service (§7.2) with `shareId = LOOSE_SHARE_ID`. The lock covers only admission; the hash never runs under it, so several adds in one space no longer serialize.
3. **Publish on the shared lane.** The loose channel resolves the path from the recorded source, advertises a placeholder entry (no hash yet — peers render `preparing`), then streams the file **once**, computing the whole-file content hash and the chunk map in the same pass (`prepareForServe`, §7.7); finalizes the entry and makes the hash servable. An interactive item rides the express lane, so a dropped-in file starts even while a folder backfill holds every bulk slot. `files:add` resolves once the item has settled — and, after a cancel, once its executor has honoured the abort and reverted.
4. **Track + watch the source path** — kept for reveal-in-file-manager, watched so edits/moves are noticed. A watcher `change` enqueues a re-publish, an `unlink` a retire; the retire executor confirms the file is gone under exactly that name before tombstoning. Boot re-enqueues every entry with a recorded source; the presence sweep proposes retires by exact name on two consecutive misses and skips any path with a queued or running item.

Progress streams locally as `event:decoration { channel:'transfer', phase:'publishing' }` and to peers as share-prepare frames that the receiver re-emits as `phase:'preparing'`, so their `preparing` rows show live progress. `files:cancel-publish` aborts the hash mid-stream; a half-advertised entry is always reverted — the prior version re-advertised, or a first-time publish tombstoned. `files:remove` on an own file tombstones the catalog entry and drops the serve reference (evicting the chunk map on the hash's last reference); on a merely-downloaded peer file it only deletes the local download claim.

#### Downloading a file (overlay engine)

`files:download` routes to the shared **overlay download engine** (`transfer/backends/overlay/overlay-download.js`; `transfer/loose-overlay.js` supplies the loose glue; the same engine serves non-mirrored folder-share reads). Observers (Finder/Explorer, Quick Look, backup tools, antivirus, the orphan sweep) only ever see no file or a complete file — never a half-written one under the real name:

1. **Destination.** `resolveDest(downloadDir, basename)` (`download-dest.js`) picks a free final name — a name is taken if the plain file or `<name>.mirall.part` exists. A download never overwrites the user's own file nor adopts another transfer's partial. A resumed download reuses the pending row's `finalPath`.
2. **Pending row first.** `recordPending` writes the §3.4 row before any bytes move. The engine is single-flight per file.
3. **Fetch by content hash** through the overlay (§7.7). Bytes land in `<finalPath>.mirall.part`; chunks verify against the chunk map as they arrive; a **receive journal** (app-private `journals/` — received-chunk bitmap + streaming-hash snapshot) makes resume O(1); partial → final is an atomic rename.
4. **Progress is decoration, never status.** Ticks emit `event:decoration` and persist `bytesTransferred`; the row's *status* is always re-derived by `files:list`, never pushed.
5. **Completion.** Pending row cleared, Downloads bee marked (`markDownloaded` + the verified hash), `event:transfer-complete` + `event:files-updated`.

**Pause / cancel / discard.** `files:pause-download` stops the fetch but keeps partial + journal + row (`event:transfer-paused`); a manual pause is remembered so reconnects don't resurrect it, and a fresh `files:download` resumes from the journal. `files:cancel-download` / `files:discard-partial` unlink partial + journal and clear the row.

**Failure semantics.** Recovery is level-triggered, with **no retry budget** — see the table in §4.5.

**Boot sweeps.** `cleanupOrphanedPartials` removes `.mirall.part` files (download dir + every foreign mount) that no pending row or journal references — a resumable partial is preserved. `cleanupOrphanedJournals` drops corrupt, stale (>7 d), or partner-less journals. Shutdown marks nothing: resume state reconstructs from the durable rows.

### 3.5b Audit-log bee (`audit-log`) — local only, never replicated

The on-device activity record (`shared/audit/`). Registered in `LOCAL_BEE_NAMES`, so it inherits
the M-derived at-rest encryption, the metadata migration and the leftover-scan wanted-set.

| Key | Value |
|---|---|
| `evt/<seq zero-padded to 16>` | the audit record (schema v1) |
| `by-space/<spaceId>/<seq>` | `seq` — the space filter's index |
| `config` | `{ enabled, retentionDays, maxEntries }` — worker-owned |
| `seen/<beeId>` | the version of a peer's bee already turned into rows (§3.5c). Working state, not a record — `audit:purge` deliberately leaves it |

Zero-padded seqs make lexicographic order numeric order, so one reverse range scan is both the
newest-first listing and the pagination cursor. `seq` is a monotonic local counter, never
`Date.now()`: a backwards clock jump would otherwise reorder or collide rows.

**Every row is self-contained.** Participant names (`actor` / `space` / `target`) are snapshotted
at write time because nothing can be joined at render time — §6 deletes the space record on
leave, and a peer's name needs that peer reachable. A `search` blob of lowercased proper nouns
backs free-text search; the *kind* is deliberately excluded so stored text stays locale-neutral
(the renderer resolves a typed term against translated kind labels and passes matching kinds as a
filter).

Attribution is recorded per row as a tier: **A** first-party, **B** a peer action authenticated
through the §16 identity binding or a Noise-authenticated socket, **C** derived from a peer's
replicated bee (authorship proven, timestamp self-reported). A transfer between two *other*
members is unobservable — overlay transfers are point-to-point, so only the holder sees them.

Volume is bounded structurally: no event class scales with file count (a folder share is one row
carrying the totals; the recurring reconcile records nothing), byte-moving activity is folded into
one row per transfer by `audit-sessions.js`, and a per-kind token bucket collapses any overflow
into a single `audit.suppressed` row.

Retention prunes by age **and** count on boot and daily (`maxEntries`, default 200k, binds
whenever a burst outruns the age window). It bounds the **row count, not the bytes**: a Hyperbee
`del` only appends a tombstone, so pruned rows stop being readable while their blocks stay on
disk. Byte reclamation is deliberately not attempted — `core.clear()` over the pruned range is
unsafe here, because every Hyperbee block carries B-tree index data alongside its key/value, so
clearing old blocks strands index nodes the live tree still points at (measured: after clearing a
pruned prefix, a fresh open reads back **0** surviving rows and stalls on a missing block).
Residue after RocksDB compaction is on the order of ~1&nbsp;KB per pruned row, retained
indefinitely — see the NOTE above `pruneAudit()` in `audit-log.js`.

**`audit:purge` is the one path that does reclaim.** A purge discards the whole event set, so it
can reset the core outright where a partial prune cannot: `truncate(0)` empties the tree in place
and drops its blocks, and a `compactRange` then returns the bytes (measured: 8.3&nbsp;MB
of log → 0.08&nbsp;MB, against 22&nbsp;MB when the same rows were deleted key-by-key). Truncation
rather than a core purge-and-recreate is deliberate — recreating the core hands back a stale
corestore tracker entry whose storage is gone, and every later read hangs. The retention config and
the `seen/` watermarks are written back across the reset; `pstate/` is not, since observed peer
state is log content.

**The log survives a space leave** — a deliberate exception to §6's "leave removes everything
space-scoped" rule, since a space left under dispute is exactly when the trail matters. It never
replicates and never leaves the device; `audit:purge` is the user's explicit wipe.

#### Observing peer actions

A peer's profile bee and share catalog are append-only logs, so "what did they just do" needs no
snapshot of their records — only the version we last processed (`seen/<beeId>`) plus
`createHistoryStream`, which replays the put/del operations since then. `audit/peer-observer.js`
classifies those operations; `audit/peer-watch.js` resolves names and writes the rows.

Three rules make it correct:

- **Baseline at registration, after a head sync.** Taken when the watch is attached rather than on
  the first append — adopting lazily swallows the very first act, and adopting before the head
  replicates turns a peer's whole existing catalog into a flood of "just shared" rows.
- **Fingerprint dedupe.** One logical act can be several puts (a mirror record is written
  `syncing` then `active`), so changes collapse to a stable fingerprint; the opposite transition
  clears it, so mirror → unmirror → re-mirror still records three times.
- **Relevance gates.** A share/file event counts only for a space we are in; a mirror event counts
  only when the mirrored share is *ours*. Folder-share catalog contents are excluded outright —
  one mount is one act (`share.mounted`), never five thousand file rows.

This yields the peer-action kinds (`peer.file_shared`/`_unshared`, `peer.share_created`/`_deleted`,
`mirror.peer_mirrored`/`_unmirrored`), all tier C: authorship is proven by the bee signature, but
the timing is the author's clock and we learn of it only when their append reaches us.

### 3.6 Mounts bee (`mounts-meta`) — local only

Owned by `src/shared/folders/mount-store.js`. Records which local paths back a share and which mirror a peer's share. §7.

| Key | Value |
|---|---|
| `owned-folder-mount/<spaceId>/<shareId>` | `{ spaceId, shareId, mountPath, ignore[], createdAt, lastScanCompletedAt? }` |
| `foreign-folder-mount/<spaceId>/<shareId>` | `{ spaceId, shareId, ownerKey, mountPath, enabled, attachedAt, status?, initialScanCompletedAt? }` |

### 3.7 Share catalogs & encryption at rest

Each folder/loose share has a replicated **catalog** (`shares/share-catalog.js`) that the overlay backend advertises into and consumers list from: per-file path, size, mtime, content hash — keyed by the share's `catalogKey` and encrypted with the space's SCK, so only members can read it.

#### Write discipline for status-bearing rows

A write that encodes **status or intent** — a transfer's `errorCode`, a claim, a pending row, a leave marker — may fail loudly, never silently. Await it, log at `warn` with the key and the code, and then do one of three things, saying which in a comment: fail the caller (the user asked for something durable that did not happen), let the level-triggered scan finish the intent (the durable state already implies it), or hold the verdict in memory for the process (the write is the only thing suppressing a re-drive). A bare `.catch(() => {})` is reserved for teardown races, safe reads, observability writes, and display-only values, and carries a comment naming the race. `log.debug` does not count as surfacing: the default level is `warn`.

The local-only bees (§3.2–3.4, §3.6) are encrypted at rest with an M-derived key. The **profile bee stays plaintext** because peers must read it. §16.

### Why per-user drives (no Autobase)

Each user writes only to their own drive: no conflicts, inherent ownership, trivial aggregation at list time. Peer drives are read-only by design.

---

## 4. Networking

### 4.1 Hyperswarm topology

Two swarms, sharing the same Corestore (passed from main into the worker), so any incoming `store.replicate(socket)` works against the unified store:

- **Main-process swarm** — joins only the upgrade-drive discovery key, as a client, for `pear-runtime-updater`.
- **Worker swarm** (`transfer/swarm.js`) — one 32-byte topic per space; handles peer file-sharing connections.

Topic join is non-blocking (`discovery.flushed()` in the background). `swarm.on('connection')` drops sockets immediately when the user is in zero spaces, so stray peers never reach handshake code.

### 4.2 Protomux handshake

Two channels multiplexed on one socket:

1. **Corestore replication** — `store.replicate(socket)` syncs all Hypercore data.
2. **`mirall/handshake`** — JSON messages of two types:

```json
{ "type": "handshake", "profileKey": "<hex>", "driveKey": "<hex>",
  "displayName": "<string>", "spaceTopic": "<hex>" }
{ "type": "leave", "spaceId": "<id>", "profileKey": "<hex>" }
```

Every identity-asserting frame carries a signature binding sender → socket Noise key (§16).

**Handshake:** one per local space per connection. `channel.onopen` iterates every joined topic (`sendHandshakeMessages`).

**Identity-frame rate limit.** `admitIdentityFrame` charges a per-socket dual-lane token bucket (`handshake-guard.js`) keyed on the Noise key: frames for a topic we joined ride the *matched* lane, everything else the generous *unmatched* lane, so a multi-space peer's foreign-topic frames can't starve the one that matters. The matched lane's burst is `handshakeBurst + handshakeBurstPerTopic x the distinct topics THAT SOCKET has matched` (8 + 3 per shared space, re-read per take and never counted past the topics we hold), because an honest reconnect legitimately sends one frame per shared space plus our reciprocal — a fixed burst banned any pair sharing 24+ spaces, while scaling by our own space count instead would hand a peer that matched one topic an allowance that grows with every space we join. Refill is 1/s; the drop counter decays at the same rate, and 24 consecutive drops on either lane evict the Noise key (`bannedNoiseKeys` -> the swarm firewall) for the process lifetime.

**Leave frame:** broadcast by `space:leave` to every connected socket *before* local teardown (§6). `handleLeaveFrame` verifies the claimed `profileKey` is already authenticated on this socket via `socketToPeers` — **spoof guard**; without it any connected peer could kick a third party out of others' member lists — then prunes the leaver from persisted `members`, evicts from `connectedPeers`/`socketToPeers` (so the eventual disconnect doesn't fire a duplicate `event:member-left`), and emits `event:member-left`.

**On receipt (`handleHandshake`):**

1. Match `spaceTopic` → local `spaceId`; ignore unknown topics.
2. **Gate before admitting.** While we ourselves are still pending in the space (no SCK yet), stop here. For a v2 space, `admitV2Member` enforces the read gate: only a peer we or a co-member approved is admitted; anyone else is recorded as a converging join request and the handshake ends.
3. Upsert a `connectedPeers` entry keyed by `profileKey`. One peer can be connected on behalf of many spaces — `peerEntry.spaces: Map<spaceId, driveKey>`. No peer drive or catalog opens here; catalogs open lazily on first read.
4. Emit `event:member-joined` immediately (with any cached avatar) so the UI unblocks without waiting on replication; clear any stale join-request entry.
5. Fire the overlay reconnect hook — pending downloads from this peer auto-resume (§4.5).
6. **Reciprocal handshake:** if the peer is new to this space, send ours back. Without this, two peers who joined a space late can stay invisible to each other.
7. Persist the peer as a member if new, emit `event:members-updated` — a handshake is also a presence arrival (§4.7).
8. Asynchronously fetch the peer's avatar from their profile bee (retried — the block may not have replicated yet); a changed avatar updates the member record.

When a new space is joined while connections already exist, Hyperswarm reuses the sockets and fires no `'connection'` event — so `joinSpaceTopic` walks `socketMsgHandlers` and sends the new-space handshake to every already-connected peer.

### 4.3 Peer catalog caching

Peer file metadata lives in replicated catalogs, not drives (§3.5). A peer catalog bee opens lazily on first read (`openPeerCatalog`, keyed by catalog key, decrypted with the space SCK) and caches in `peerCatalogs`; reads fan out in parallel and are bounded by ONE interactive timeout per peer covering head sync and drain, so an offline peer can't stall a listing. A peer whose head sync spends the whole budget still has its drain run, with `wait: false` — only blocks already on disk are read, so previously replicated rows keep surfacing instead of the read parking for a second budget. Catalog appends fire per-owner watches (`watchPeerCatalog`) that nudge foreign mirrors (§7.3) and re-drive pending downloads (§4.5).

### 4.4 Disconnect & multi-socket handling

- `socketToPeers: Map<socket, Set<profileKey>>` — reverse index for disconnect.
- If a peer reconnects on a new socket, the old socket's `close` handler runs *after* the peer entry was updated; it guards with `if (peer.socket !== socket) continue` so it can't delete a peer that already reconnected.
- On genuine disconnect: `event:member-left` + `event:files-updated` per space, presence lease cleared instantly, `connectedPeers` entry dropped. In-flight fetches notice the lost holder themselves and derive `paused-offline`; pending rows stay.

### 4.5 Pause / resume transfers

Recovery is **level-triggered** — reconnects and catalog changes re-drive the durable pending rows. The one exception is the stall retry below: a holder that goes silent without ever disconnecting fires no level change at all, so there is nothing for a reconnect to re-drive.

| Event | Effect |
|---|---|
| Owner goes away mid-fetch | Not terminal. Partial + row kept, `event:transfer-paused { reason:'offline' }`; status derives `paused-offline` / `paused-interrupted` |
| Fetch stalls while the owner stays online | Retried by the engine itself with exponential backoff (FIX-BW9). A code-less fetch failure is either a vanished holder or one throttled past our watchdog, and neither fires a reconnect or an append — so pre-fix the row simply parked. The retry gives up after `STALL_RETRY_DRY_LIMIT` attempts that bank **no new bytes**, which is what separates a wedged holder (parks, as before) from a slow one (keeps going). While a retry is pending the paused event still fires, flagged `retrying` — on the folder channel that emit IS the terminal decoration frame, so withholding it strands a progress bar; the flag only suppresses the loose channel's OS notification |
| Owner reconnects | The overlay reconnect hook fires `resumeLooseForOwner` / `resumeOverlayForOwner`, re-driving every pending row for that owner (skipping active, manually-paused, and checksum-failed rows) |
| Owner republishes (catalog append) | The per-owner catalog watch re-drives pending rows; an in-flight fetch of a superseded hash is cancelled and re-fetched (`event:transfer-superseded`) |
| Integrity failure (`EHASHMISMATCH`) | `TRANSFER_CHECKSUM` — **terminal**, never auto-resumed (the same holder would fail identically). Only an explicit user retry re-attempts (§14). The verdict is written to the row; if that write fails the engine holds it in memory for the process and logs at `warn`, so the row is still not re-driven until a restart |
| Download completed, row outlives the claim | The next reconcile sees the file claimed on disk and clears the row; nothing is re-fetched |
| Any other engine error | `DOWNLOAD_FAILED` on the row → `error` status until the user retries |
| Worker shutdown | Nothing is marked; durable rows (§3.4) reconstruct resume state next boot/reconnect |

### 4.6 Startup reconnection

Open Corestore → load profile → load spaces → init downloads bee → init pending-transfers bee → re-open all local drives — a drive that fails to load keeps its space record, stamped `driveLoadError`, and is retried next boot; only a positively identified storage inconsistency drops the record → orphan-core cleanup if any load failed → join all topics. Peers rediscover via the DHT; pending transfers resume as their owners reconnect.

### 4.7 Presence & liveness

Liveness is tracked separately from connection state. Peers hold short-lived **presence leases** — heartbeat-refreshed, TTL-expired, cleared on disconnect (`state/presence.js`). `connectedPeers` stays the routing registry ("where to send frames"); the lease answers "who is online".

Durable state changes reach the renderer as **level-triggered hints**: the worker coalesces them into `event:reconcile { scope }` (`state/hints.js`) and the UI refetches that scope, so a missed event can never leave the UI stale. Every list view rides this channel — `files`, `shares`, `share-files`, `members`, `join-requests` — fanned from the named `*-updated` pokes via `POKE_SCOPE` (`core/ipc.js`). The named events stay on the wire as the emit-site API and as test/debug observables.

### 4.8 Blind relay (behind the `relay` feature flag, default off)

When two peers cannot hole-punch to each other, `hyperswarm`'s `relayThrough` option routes the connection through a **blind relay** — a `hyperdht` node that pairs two raw UDX streams by token. Noise runs *over* the relayed stream, so the relay sees ciphertext only. The client side is entirely built into the stack; Mirall only decides which key to supply and when.

- **Configuration** is one 32-byte public key per relay, stored in `config.json` under `network` (`relayMode: 'off' | 'auto' | 'always'`, plus a `relays` array). Main validates every key with `hypercore-id-encoding` before persisting (`main/relay-keys.js`) and re-sanitizes the block on load — a hand-edited file cannot smuggle a malformed key onto `relayThrough`.
- **Delivery**: the `bootstrap` frame carries `relayEnabled` / `relayMode` / `relays` to the worker; live changes ride `network:set-relays` over the existing NDJSON channel, and re-apply without a restart.
- **Application** — `setRelayThrough` (`transfer/swarm.js`) installs the relay function on **both** the control and content swarms. Configuring only the control swarm yields a build whose handshakes connect and whose transfers stall, so it must run **after** `initContentSwarm` — the two swarms are constructed on consecutive lines in `worker/main.js` and `getContentSwarm()` is null in between.
- **Mode** maps onto hyperswarm's own semantics: `off` installs no function at all (byte-identical to a build without relay support), `auto` engages after a failed punch or on a randomized NAT, `always` relays every connection (the only way to *test* a relay end-to-end).
- **Probe** — `network:test-relay` dials the key and waits for the `blind-relay` Protomux channel to open, so a mistyped key fails at paste time rather than weeks later as a space that silently never syncs.
- **Gate** — `isRelayEnabled()` short-circuits `setRelayThrough` to `null` and the probe to `{ ok: false, reason: 'disabled' }`. With the flag off, a stale `config.json` carrying `relayMode: 'always'` cannot change transport behaviour. Note this stops us *offering* a relay; per hyperdht's negotiation, a peer that advertises its own relay key is still honoured, so a flag-off build is not "relay-free".
- **Enabling it** without a build, for QA or a self-hoster: `MIRALL_FEATURE_FLAGS='{"relay":true}' npm start`. Flags are primed once per process, so the change needs an app restart. Obtaining a key is an operator task — a relay publishes the public key of its `hyperdht` node, and that string is the entire client-side configuration.

---

## 5. Invitation Mechanism

1. Creator generates a space → 32-byte random topic → formatted invite code.
2. Code displays as dashed 8-char segments (`formatInviteCode`).
3. Joiner pastes the code or clicks a deep link; `decodeInvite` recovers the topic and any metadata.
4. Joiner's app creates a local drive (same namespace scheme), stores metadata, joins the topic.
5. On first connection the protomux handshake exchanges drive keys; reciprocal handshake + Corestore replication do the rest.

### 5.1 Invite envelope formats

Two wire formats coexist. `decodeInvite` accepts either; `encodeInvite` always emits v1.

| Version | Shape | Use |
|---|---|---|
| **v0** (compat) | Bare 64-char lowercase hex — `topic` only | Emitted by older clients; older peers paste the dashed hex code |
| **v1** | Base64url-encoded JSON, `{v:1, t:<hex64>, …}` | Default. Carries the space name (`NAME_MAX = 80` chars, truncated) plus owner/creator, schema version, invite id, expiry, and auto-admit policy (`encodeInvite({ topic, name, owner, ownerName, creator, schemaVersion, autoAdmit, inviteId, expiresAt })`) |

`decodeInvite` strips dashes/whitespace, tries hex first (v0), then base64url-JSON (v1); anything else returns `null`.

The renderer (`renderer/invite-envelope.ts`) and worker/main (`shared/invite-envelope.js`) keep separate copies because they run in different module systems (TS+ESM vs JS+ESM; Electron main needs CJS-friendly access via `main/deeplink.js`'s dynamic import). Behaviour is identical and tested at the boundary — **diverging the two silently breaks invites.**

### 5.2 Deep-link delivery

`mirall://join/<code>` (or `mirall://join/?code=<code>`) launches or focuses Mirall and pre-fills the Join Space dialog. `<code>` is a v0 hex string or a v1 envelope; `parseDeepLink` (`main/deeplink.js`) validates protocol + host + code.

| Platform | Hookup | Triggered by |
|---|---|---|
| **macOS** | `setAsDefaultProtocolClient` → `LSSetDefaultHandlerForURLScheme`. Cold + warm both arrive via `app.on('open-url')` | Browser click, `open mirall://…`, Messages tap |
| **Windows** | Same call writes the registry entry. **Cold**: URL lands in `process.argv`, scanned for `mirall://` (paparam would reject positional URLs). **Warm**: `requestSingleInstanceLock()` + `app.on('second-instance')` forwards argv to the running instance | Browser click, Run dialog, second `Mirall.exe mirall://…` |
| **Linux** | `.desktop` declares `MimeType=x-scheme-handler/mirall;` and `Exec="…/Mirall" %U`. AppImage installs rewrite `~/.local/share/applications/Mirall.desktop` on every launch (`integrateXdgLinux`, §2 step 11); deb installs ship the same MimeType statically. Same single-instance + argv path as Windows | `xdg-open`, browser click, `gio open mirall://…` |

**Cold-start queue.** Links can arrive before the renderer mounts, so main buffers them in `pendingDeepLinks[]` until the renderer's `bridge.deepLink.subscribe(fn)` triggers `deeplink:flush`. Later links forward live. `revealWindow()` runs on every dispatch.

**Renderer routing.** `app.tsx` subscribes once at mount, accumulates a `linkQueue`, routes each link to `JoinSpaceModal` with code (and name) prefilled. Subscribing returns the unsubscribe fn so React's effect cleanup tears the listener down.

**Security.** The topic is a shared secret; anyone holding a code can *knock*. The deep-link layer adds no new authority — `mirall://join/<code>` is exactly equivalent to pasting `<code>`. The `name` field is a UI hint the joiner can override. Read access still requires approval (§16, §14).

---

## 6. Space Leave & Cleanup

Multi-step, with progress events (`event:leave-progress`):

1. Cancel in-flight uploads (`cancelSpaceUploads`) and downloads (`cancelSpaceDownloads`).
2. **Propagate the leave** — *before* the topic disconnect, while sockets are alive:
   - *Instant:* `sendLeaveFrameToConnectedPeers(spaceId)` broadcasts a `leave` frame on every live `mirall/handshake` channel. Receivers prune within ~1 RTT.
   - *Eventual:* `clearOwnMembership(spaceId)` deletes `member/<spaceId>` from the local profile bee. Replication carries the deletion to anyone who later connects — including peers offline at leave-time.
3. Leave the Hyperswarm topic.
4. `cleanupSpaceDrives` — per member, close the cached drive's blobs + meta cores, then `purgeCoreDk` the discovery keys out of Corestore's RocksDB. Progress emitted per peer.
5. `cleanupDownloadHistory(spaceId)`.
6. `clearPendingForSpace(spaceId)`.
7. `purgeSpaceDrive(spaceId)` — close the local drive, purge meta + blobs cores, RocksDB compaction.
8. `purgeSpace(spaceId)` — delete the space row.

`purgeCoreDk` writes RocksDB tombstones directly for the `TL_CORE_BY_DKEY`, `TL_CORE`, `TL_DATA` ranges. **Not** `Corestore.deleteCore()` — it short-circuits when auth blocks are missing, leaving zombie aliases that crash later opens with `STORAGE_EMPTY` / `unslab`.

### Interrupted-leave recovery (durable `leaving` marker)

The teardown's edge signals can be lost: a quit mid-teardown used to leave the space record present, and boot's `markOwnMembership` backfill re-PUT `member/<S> = {active:true}`, silently reversing the leave.

So the teardown persists a durable `leaving: true` marker on the space record as its **first** durable step (`markSpaceLeavingDurable`, riding `mutateSpace`'s serialized write chain, before `clearOwnMembership`). A clean leave deletes the whole record (`forgetSpaceRecord`), so the marker only ever survives an *interrupted* teardown.

At boot, before the membership backfill, `resumeInterruptedLeave` completes any space still carrying it:
- re-run `clearOwnMembership` — the hard gate; a throw keeps the marker so the next boot retries the `del`;
- best-effort delete the space's owned/foreign **mount records** (the watcher/mirror restart loops iterate the mount stores, not the space list — a surviving record would re-arm against a forgotten space);
- tombstone own share ads; drop the record. The boot call site also purges the space's download-history + pending-transfer rows (spaceId-keyed, no sweep reclaims them). Leftover cores/partials are reclaimable garbage for the existing sweeps.

A `leaving` space is invisible everywhere it matters — `loadDrives`, the backfill/topic-join loops (`activeSpaces`), `openMemberView`, and the renderer projection (`slimSpaces` / `space:members`) all skip it. `joinSpace` clears a surviving marker when a rejoin reuses the record, so a failed completion can never delete a space the user rejoined.

### Fold-observed leave revoke (offline approver)

`handleLeaveFrame`'s cleanup triple (`markLeft` + `persistLeftTombstone` + `revokeApproval`) only ran on the **live** frame, which reaches connected sockets only. An approver offline at leave time therefore never revoked its grow-only vouch — so a departed member re-asserting `member/<S> {active:true}` was silently re-admitted off it.

The member view now surfaces `inactive` from `deriveMemberSet` — peers whose record was actually **read** as `active:false` (a replicated `del`); never a null/unreplicated peer, never a cascade victim. `member-registry.applyObservedLeaves` mirrors the frame handler for peers that were in our prior-member belief and now read inactive.

**The revoke comes first and gates the tombstone.** A failed revoke leaves the key unhandled (no `markLeft`), and since the surviving vouch keeps it seeded in `prior` at the next view open, the retry is self-sustaining across sessions.

Prior-member belief (`entry.prior`, a `Map<key, lastKnownTs>` that also stamps the tombstone's single-clock `leaveTs`) is seeded at view open from the durable roster (`space.members`) **and our own authored approvals** — the roster alone can lose a vouchee that reconcile dropped on a transient null read — and grows with each fold, so the observation also fires when the `del` lands before the session's first fold (approver restarted). `isLeft` guards against double-acting after a received frame. The pure decision is `observedLeavers` in `member-set.js`.

### Membership reconciliation

The persisted `members` array is a high-water mark — handshakes only add. Three triggers run `reconcileMember(spaceId, member)`: on handshake completion (for every *other* persisted member), on a peer's profile-bee `append` (deduped via `profileBeeAppendListeners`, across every shared space), and on worker startup (`scheduleReconcileForAllSpaces()`, after `loadDrives()` and before `joinSpaceTopic`).

Each pass **short-circuits on live handshake state**: a peer currently in `connectedPeers` for this space is by definition active, so the reconciler returns without any bee reads. This saves work *and* prevents false-prune races where the peer's rejoin write hasn't replicated to us yet, or a witness's stale observation hasn't been cleared.

When the peer is not live, two evidence sources are evaluated:

| Source | Read | Resolution |
|---|---|---|
| **Manifest** (the leaver's own bee) | `readPeerMembership(leaverPk, spaceId)` — checks `caps/membership-manifest`, then `member/<spaceId>` | `false` ⇒ prune · `true` ⇒ keep · `null` ⇒ fall through to witnesses |
| **Witnesses** (any connected peer's bee) | `anyConnectedPeerObserved(leaverPk, spaceId)` — parallel reads of `observed/<leaverPk>/<spaceId>`, gated by `caps/leave-observations` | Any "yes" ⇒ prune · all "no"/`null` ⇒ keep |

The live-state check repeats **once more before the prune commits**, since the reads are async and a handshake may have landed during them. Pruning requires both that the evidence agrees *and* that the peer is still absent from `connectedPeers`.

To keep witness evidence honest, `handleHandshake` clears our own `observed/<peerPk>/<spaceId>` whenever a peer handshakes us for that space — a live handshake proves they reverted whatever leave we witnessed.

**Why two sources:** the manifest is the leaver's self-declared truth but is unreachable while they're offline. Receiver-side observations are written redundantly by *every* peer that witnessed the leave, so the fact survives the leaver going offline forever. Reads are `caps`-gated so old clients that don't publish observations read as *unknown*, not negative.

Pruning is conservative: only a **positive** evidence read deletes from `members`; `null` on both sources ⇒ keep. `reconcileInflight` dedupes concurrent reconciliations of the same `(spaceId, profileKey)`.

When the reconciler prunes it **cascades** — writing its own `observed/…` entry. A peer who learns of a leave via a witness becomes a witness, propagating the fact transitively across the mesh.

**Why this isn't timeout-dependent.** The earlier design relied solely on the manifest: receivers had to read the leaver's bee within a 5-second window. With observations the fact is recorded redundantly across every witness, so receivers offline at leave-time learn it from any witness and the leaver need never come back online. The timeouts (5 s bee reads, 500 ms flush in `space:leave`) are now belt-and-braces, not load-bearing.

---

## 7. Folder Sharing (Owned & Foreign Folders)

Publishes a whole local directory tree into a space and lets any peer mirror it locally. It sits *on top of* the per-space drive — no new core types — by reserving a path **prefix** per share. Loose files and shares coexist; `listFiles` excludes share-prefixed paths from the loose catalog.

### 7.1 Concepts

| Term | Meaning |
|---|---|
| **Share** | A named folder offered into a space. Record `{ id, type:'owned-folder', name, owner, createdAt, deletedAt? }` published to the **owner's profile bee** at `share/<spaceId>/<shareId>`, so it replicates to peers |
| **Share prefix** | The share's files live under `/<ShareName>/…` (`sharePrefix(name)`) |
| **Owned folder / owned mount** | Owner side. A local `mountPath` attached to a share; a chokidar watcher keeps the share in sync with it. Persisted at `owned-folder-mount/…` |
| **Foreign folder / mirror** | Consumer side. A local path receiving a *read-only* copy of someone else's share, continuously materialized. Persisted at `foreign-folder-mount/…` |

Catalog entries carry `{ mtime, hash }` so both sides diff disk vs. catalog by content hash instead of re-transferring unchanged files.

Module map: §11.

### 7.2 Publishing (owner side)

1. **Mount** (`owned-folder:mount`). After `mount-validate` passes, save the owned mount, ask main to start a chokidar watcher, emit `event:owned-folder-mount-status: 'scanning'`.
2. **Initial scan** (`initialPublishScan`). A **diff-and-enqueue** producer: walks the tree **stat-only** honoring `ignore` globs (`DEFAULT_IGNORE` covers `.DS_Store`, `Thumbs.db`, `*.mirall.part`, `.git/**`, `node_modules/**`, …), diffs against the catalog by **size+mtime** — the git-index change signal, no reads for unchanged files — and enqueues one `publish` item per new/changed file and one `retire` item per catalog entry with no file behind it (never when the mount root itself is missing). It resolves once the share's items have settled, with `{ uploaded, deleted, totalOnDisk }`, which the worker emits as `event:owned-folder-scan-completed`. The content hash is published as entry metadata for mirrors to verify against; it does **not** drive owner-side change detection.
   **The publish queue** (`folders/publish-service.js` over `publish-queue.js`, `publish-scheduler.js`, `publish-runner.js`, `work-item.js`). Every producer — mount, relocate, boot, the watcher, the catch-up, the periodic reconcile and a loose-file add — only enqueues; one scheduler executes, and the runner hands each item to the **channel** its share id selects (`folder`, registered by `owned-folders.js`; `loose`, by `loose-overlay.js`): the channel resolves the path, publishes or retires, and declares whether it writes direct or through the space's catalog batch. A work item is keyed by **path** (`shareId\0relPath`), never by content hash: at most one live item per path, so a second request folds into a queued item or marks a running one dirty for exactly one rerun — a file can never be read twice concurrently. Queues are **per space**; a bounded runner (`publishConcurrency`, default 2) hands slots out round-robin across spaces, and while more than one space has work no space may hold every slot, so a large index in one space never stalls another. Within a space the order is a runtime-config knob (`publishOrder`: `fifo` | `smallest-first` (default) | `largest-first`; not surfaced in `config.json`); an interactive item (a watcher event) outranks a bulk backfill, and a retire outranks a publish. Scheduling is non-preemptive, so interactive items also get an **express lane**: one may run past `publishConcurrency` while every bulk slot is held by a running hash. Bulk items — publishes and retires alike — write through one catalog batch per space (few atomic heads for the consumer); an interactive item first lands whatever the batch holds, then writes direct, so a dropped-in file is visible at once and no staged op can land after it and undo it. **Every executor re-derives its precondition from current state**: it re-resolves the mount (a relocate leaves enqueue-time paths stale), refuses to act when the root is missing (a vanished root makes chokidar emit one `unlink` per file), and a retire confirms the file is gone **under exactly that name** (`disk-presence.js`: a following stat would call a case-only rename or a symlink "present" forever) — absence from a minutes-old snapshot is a candidate, never a delete. A cancelled item stays the path's one live item until its executor honours the abort (a request arriving meanwhile becomes its rerun), and a cancelled pass resolves `cancelled: true` — the worker records no status for it. Unchanged files the diff skips still get their serve registration checked (`ensureServable`), so a transient `registerFile` failure heals on the next pass. `owned-folder:index-status` / `owned-folder:cancel-index` expose and cancel a share's queue; `event:owned-folder-index-progress` (decoration, coalesced) carries its progress.
3. **Live updates** (`onFsEvent`). `add`/`change` enqueue an interactive `publish`; `unlink` enqueues an interactive `retire`. The executor applies the guards (root must still exist, file confirmed gone — an editor's rename-over fires a raw unlink for a path that is immediately back). `echo-guard` drops events for paths the worker itself just wrote — no upload-of-our-own-download loop. A 2 s-debounced catch-up diff follows quiet periods (macOS fsevents coalescing drops adds); it enqueues only what is missing and leaves a file younger than 2 s with no catalog entry to the watcher's `awaitWriteFinish` rather than reading it mid-copy — and re-arms itself with backoff (2 s → 60 s) while a pass deferred anything, since the deferred file's own add may be the one that was dropped.
4. **Periodic reconcile.** A recurring timer re-runs the fast stat-only diff to heal what the watcher missed (sleep, dropped events). Every Nth pass (`deepReconcileEvery`, default 4 → ~daily at the 6 h interval) runs **deep**, content-hashing every file to catch an in-place rewrite that preserved size+mtime. Boot and the periodic pass enqueue into the same queue as everything else, so several mounted folders no longer hash concurrently.
5. **Relocate** (`owned-folder:relocate`). Moves the mount; runs a **deep** reconcile so an identical tree at the new path — whose mtimes typically differ after a move/copy — relocates with zero re-upload and no mirror churn.
6. **Delete** (`owned-folder:delete`). Stop the watcher, tombstone every entry under the prefix, delete the mount record, tombstone the share record — which cascades to every peer's mirror.

### 7.3 Mirroring (consumer side)

1. **Mirror** (`foreign-folder:mount`). After `mount-validate` passes (foreign mounts additionally reject paths inside `~/Downloads`), save the mount (`enabled:true`) and start the materialize loop.
2. **Initial materialize** (`initialMaterializeScan`). List the owner's share prefix, download everything to the mount path, recording each delivered path in `syncedPaths`. Pre-existing user files at the destination are left untouched.
3. **Steady state.** Membership of an already-mirrored path is an in-memory `Set` per mount (seeded from the persisted `syncedPaths` array, which keeps its shape — no migration), so a converged tick is linear in the file count rather than quadratic; a path is claimed *before* its bytes land, so a pass cancelled mid-file still owns what it wrote, while the collision check still treats a path claimed by the current pass as not-yet-ours so a pre-existing user file gets a sibling rather than being adopted. The record is written **once per pass and only when something changed**, through a read-merge patch that cannot clobber a concurrent pause or resurrect an unmounted record. `runMaterializeTick` runs every 30 s *and* on `onPeerDriveChanged` (a debounced tick fired when the owner's catalog appends — so owner edits land in seconds, not after the next poll). Each tick diffs the catalog and `applyChange`s: `put` fetches by content hash through the overlay into a `.mirall.part`, then renames; `del` unlinks a local file **only if** it is in `syncedPaths`. Per-file progress streams as `event:decoration { key: shareId+':'+relPath, … }` with a terminal `done`.
4. **Deletion safety.** `shouldHonorDeletions({ownerOnline, driveCount})` honors owner-side deletions only when the owner is online *and* the listing is non-empty — a lagged or empty replica cannot cascade-wipe a mirror. Mirrors are read-only and idempotent: no per-file retry budget; a failed file just retries next tick.
5. **Pause / unmount.** `foreign-folder:set-enabled` toggles the loop; `foreign-folder:unmount` stops it, removes the record, and reclaims cached blobs. Status flows through `event:foreign-folder-mount-status` (`active` / `scanning` / `paused-error` / `paused-enospc` / `mount-point-gone`).

### 7.4 Mount validation (`folders/mount-validate.js`)

`validateMountPath(absPath, role, ctx)` **rejects** (codes surfaced via `errorMessages.ts`): system folders (`MOUNT_FORBIDDEN_SYSTEM`), the app's storage dir (`MOUNT_FORBIDDEN_APP_DATA`), cloud-sync roots — Dropbox/OneDrive/iCloud (`MOUNT_FORBIDDEN_CLOUD_SYNC`), Windows reserved names / illegal chars (`MOUNT_FORBIDDEN_WIN_RESERVED`), overlap with an existing mount of the same role (`MOUNT_OVERLAPS`), a foreign mount inside `~/Downloads` (`MOUNT_INSIDE_DOWNLOADS`), non-writable paths (`MOUNT_NOT_WRITABLE`).

It also returns non-blocking **advisories**: macOS TCC-gated folders (Desktop/Documents), non-`C:` Windows drives that may be removable or network.

### 7.5 Path math (`folders/path-keys.js`) — pure, cross-platform

No imports, so it unit-tests on every platform. Exports: `relToDriveKey` (OS path → always-POSIX drive key), `driveKeyToSegments`, `sharePrefix`, `isInsideShare`/`isInsideAnyShare`, `relPathInShare`, `shouldIgnore` (glob match, basename-first then full path) + `DEFAULT_IGNORE`, `pathsOverlap`/`systemRootViolation`/`isWindowsReservedName`/`cloudSyncHint` (feed the validator), `shouldHonorDeletions` (mirror-delete gate), `splitFileName`/`nextFreeName` (collision-free naming).

### 7.6 Mount lifecycle & the probe loop

Mounts survive restarts (rehydrated from `mounts-meta`, §2 step 7). The 60 s **mount-probe loop** (§2 step 8) watches every mount's disk path: a USB eject or network-share drop flips the share to `mount-point-gone` and stops its watcher/loop; reappearance restarts it. State lives in the worker's `lastMountPointStatus` and `periodicTimers` maps.

### 7.7 Content backend (`overlay`)

Every share — folder and loose — moves bytes through the **overlay** backend (`transfer/backends/overlay/`). The canonical bytes are the user's **real file on disk**; nothing is copied into a Hyperdrive blob store.

1. **Publish.** Stream the file once, computing the whole-file **content hash** and the content-addressed **chunk map** in the same pass; advertise its metadata into the share's replicated catalog (SCK-encrypted, §3.7).
2. **Fetch.** A consumer lists the catalog and requests a file *by content hash* from any online holder over the `hyper-overlay/v2` Protomux channel. Chunks verify against the chunk map as they arrive; the file lands as a visible `<name>.mirall.part` beside its final name and is atomically renamed on completion, so observers see only a missing or a complete file. Serving passes the §16 authorization gates — **a denial is indistinguishable from "I don't hold it"**.
3. **Resume.** Interrupted downloads persist a **receive journal** (received-chunk bitmap + streaming-hash snapshot) in the app-private `journals/` dir, so a resume continues where it stopped rather than re-verifying from scratch. Transfers pause when the holder goes offline and resume on reconnect.

The dispatch seam is `getContentBackend(share)` (`transfer/content-backends.js`): the overlay backend for `contentMode === 'overlay'` (when the build's overlay flag is on), and the `UNSUPPORTED` sentinel for every other mode — absent, the retired `'eager'`/`'deferred'` modes, or an unknown future mode — which callers render as unavailable rather than routing to a removed path. `test/integration/content-backend-conformance.test.js` locks the contract.

**Channel version negotiation.** The `hyper-overlay/v2` channel announces `{version, capabilities}` in its protomux channel handshake. A peer that sends no handshake bytes — every build before this shipped — is read as the *unannounced* version (1) with no capabilities, so a behaviour gated on a capability bit is simply off against it. The decoder is **total**: any channel on the socket dying takes the whole socket with it, and the channel id is the public protocol string, so a decoder that could throw would hand any swarm peer a one-frame socket kill. `MIN_VERSION` is 1 today, so no installed build is refused; when it is raised (in the same change that drops a message slot or changes a codec), a peer below it loses **only its content channel** — the socket, its sibling control channel (`mirall/handshake`, or `mirall/content-hello` when the separate content plane is on) and Corestore replication all stay up.

The generic v2 serve/fetch engine is a vendored subset of the `hyper-overlay` project; `backends/overlay/vendor/PROVENANCE.md` documents what was vendored and every local modification. Mirall-specific policy (authorization, catalogs, lifecycle) lives **outside** `vendor/`.

#### Bandwidth limiting

User-set transfer caps (`transfer/bandwidth-limiter.js`) are byte-denominated token buckets — one for each direction, created in `overlay-instance.js` and **injected** into the protocol so `vendor/` keeps no app imports. Both read their rate through a getter on every call, so a settings change applies to **in-flight** transfers with nothing to re-plumb.

**The serve path decodes a file's chunk map once, not once per chunk.** A chunk-need used to re-read and JSON-decode the whole map from the file-index bee, and the scheduler re-assigns after every accepted chunk — measured at 101 bee reads for a 113-chunk file, which extrapolates to roughly 1.7 GB of JSON parsed per 1 GiB served, synchronously on the worker thread. A bounded LRU of decoded maps (`transfer/chunk-map-cache.js`, injected into the vendored `FileIndex` the way the limiters are injected; `serveChunkMapCacheBytes`, default 32 MiB, `0` disables) makes it one decode per serve; every write to a chunk-map key invalidates it, and a fence stops an in-flight decode from caching a pre-write value. Chunks are read asynchronously on **one fd per (peer, file)**, released on channel close or after 30 s idle, instead of an `openSync`/`readSync` pair per chunk.

**Every consumer holds its own `stream()` handle** — one per `ChunkScheduler`, one per peer on the serve side. There is deliberately no way to consume budget from the limiter object itself: a shared implicit handle would let two consumers overwrite each other's pending request, and a scheduler racing the bucket directly starves everything waiting its turn.

- **Upload** is charged in `_onChunkNeed` before each `chunkData.send`, against that peer's handle. `take()` resolves with the bytes actually **paid for** — `0` means the wait was aborted (limiter destroyed, peer's channel closed) and the caller must not send. The wait opens a revocation window just like the existing drain boundary, so the serve grant is re-checked on the far side of it.
- **Download** is charged in `ChunkScheduler._assign`. It is a *pull* protocol, so inbound bytes are paced by pacing chunk **requests** — by arrival the bytes are already spent.
- **Sharing is deficit round-robin, in BYTES.** Each waiting stream accrues an equal share of every refill and is granted once its balance is positive, then charged in full so it owes the difference back before its next turn. Arbitrating *turns* instead looks fair only while every transfer uses the same chunk size — and chunk size comes from the file-size tier (64 KB at tier 0, 4 MB at tier 3), so two concurrent transfers routinely differ 64x. Measured on a turn-based revision: the large-chunk transfer took 100% of the cap and the small one exactly 0.
- **Anti-barge.** `tryTake` refuses the shared bucket while any stream is queued. Without it the transfer that polls most often wins everything, because the bucket refills continuously in wall-clock time and a transfer with chunks in flight re-enters `_assign` on every arrival.
- **An oversized chunk** (tier-3 chunks reach 4 MB; a cap may be 64 KB/s) is released on any *positive* balance and the deficit repaid, or it could never be afforded at all. Deliberately not "on a full bucket": with concurrent streams the bucket never reaches full, because a stream with small asks drains each refill as it lands, and the large-chunk stream is starved outright.
- **The idle watchdog is not suppressed by pacing; it is scoped to it.** `_armIdleTimer` runs only while something is actually outstanding with a peer (`_inflight` or `_requested` non-empty). Waiting on our own cap is not silence, and with nothing outstanding there is no one to be silent. Re-arming it on a limiter heartbeat instead — an earlier attempt — makes it never fire, so a peer that wedges while still TCP-alive is never detected. Note `MIN_BYTES_PER_SECOND` does **not** keep a chunk inside the window and never did (32 KB/s x 30 s = 983,040 bytes, under the 1 MB tier-2 max chunk); it is a usability floor only.
- Caps govern the **content plane only**. Catalog/profile replication, handshakes and DHT traffic stay unthrottled — throttling them would starve the convergence that `test/flow/content-plane-hol.test.js` guards. A corrupt cap value fails **open** (unlimited), the inverse of the protective bounds in `runtime-config.js`; so does a getter that *throws*, since it runs inside a timer callback.
- **A throttled sender announces itself (FIX-BW9).** The upload cap is invisible to the peer being served — the serve loop waits on `take()` and puts nothing on the wire — so past the downloader's 30 s watchdog a capped-but-healthy holder read as a wedged one, and the fetch aborted. It tripped whenever `chunkBytes x filesFromThatPeer x peersBeingServed > 30 s x uploadCap` — at the 32 KB/s cap floor that is any chunk over 983,040 B, so a tier-2 file's max-size (1 MB) chunks fail while its 256 KB average ones do not, and a tier-3 file fails on its *average* chunk. A parked serve loop now sends a **keep-alive** (wire message 14, appended-last so older peers ignore it) naming the chunk it is paying for; the receiver re-arms its watchdog only for a peer that owes it that chunk, and only within a bound (30 min) since VERIFIED progress — a signal no remote peer can drive — so a peer that keep-alives while sending nothing is still failed. A revoked serve grant stops the announcements too, or they would tell a peer we just removed that we hold the content. Holders that predate the frame (every v1.8.0 peer) are covered on the receiver side instead, by the stall retry in §4.5.
- **Liveness is measured at the transport (FIX-BW10).** The same abort was reachable with no cap at all: a serve loop parked on stream backpressure is silent, and a single 4 MB tier-3 chunk takes 33.6 s to flush on a 1 Mbit/s wire — past the 30 s window with nothing stuck anywhere. A keep-alive answers neither (on a backpressured stream it queues behind the data it waits on). The watchdog now asks the transport before failing: **bytes arriving from that peer**, read from udx's per-packet `rawStream.bytesReceived` — secret-stream's `rawBytesRead` advances per decrypted *frame*, and a 4 MB chunk is one frame, so a frame-granular signal is blind for exactly the window that matters. Four gates keep it from becoming a watchdog that never fires: only a peer holding chunks of ours may extend (a peer that never answered our content request may never answer at all, so it is excluded), the delivery rate must clear a floor far above idle keep-alive chatter, the reach is bounded by the same verified-progress bound the keep-alive uses, and the bytes must plausibly be ours (a holder that silently dropped our batch is as busy as one mid-chunk). It needs nothing from the holder, so it covers peers already in the field. The holder's drain wait is measured the same way — it re-arms while its transport is still sending and abandons after 20 s with nothing leaving, rather than racing a flat deadline that would abandon a legitimate slow flush.

---

## 8. IPC Protocol

### Renderer ↔ Main (Electron `contextBridge`)

`src/preload/preload.js` exposes one `window.bridge`. Renderer→main goes through `ipcRenderer.invoke` (Promises) or `send`/`sendSync` (fire-and-forget / sync accessors); main→renderer events go via `webContents.send`, subscribed through `ipcRenderer.on` wrappers.

| Bridge method | Purpose |
|---|---|
| `pkg()` *(sync)* | The bundled `package.json` object |
| `isDev()` *(sync)* | True if not packaged, or `PEAR_DEV_SERVER_URL` is set |
| `getPlatform()` | `process.platform` |
| `getPathForFile(file)` | Browser `File` → absolute path (`webUtils.getPathForFile`) |
| `applyUpdate()` | Manual `pear.updater.applyUpdate()` — normally automatic (§9) |
| `checkForUpdate()` | Manual `pear.updater._debouncedUpdate()` → `{triggered, length, fork}`. Useful when the swarm connection has gone stale |
| `appVersion()` | The live drive head's `{length, fork, semver}` — what the banner renders |
| `onPearEvent(name, fn)` | Subscribe to `pear:event:updating` / `pear:event:updated` |
| `startWorker(spec)` | Spawn the worker via `pear.run(spec)` |
| `writeWorkerIPC(spec, data)` / `onWorkerIPC(spec, fn)` | NDJSON frames to / from the worker |
| `onWorkerStdout/Stderr/Exit(spec, fn)` | Worker stdio + lifecycle |
| `getWindowBounds()` / `setWindowBounds(b)` | Window-bounds persistence (in `config.json`) |
| `getConfig()` *(sync)* / `setConfig(patch)` | Read the renderer-facing slice of the unified `config.json` synchronously at boot / persist a validated patch. **Main is the sole writer**; the renderer caches the snapshot in `config-client.ts` |
| `getLocale()` *(sync)* | `app.getLocale()` (BCP-47). Seeds `i18n.ts` |
| `notify(spec)` / `notifyIsSupported()` | Native OS notification. `spec` = `{ id?, title, body, urgency?, silent?, icon?, payload?, groupId? }` |
| `isWindowFocused()` / `focusWindow()` | Suppress notifications when focused; raise the window from a click handler |
| `onNotificationClick(fn)` | `notify:click`; the worker dispatches the routed payload back through standard IPC |
| `showInFolder(fullPath)` | Reveal in the OS file manager. **Rejected unless under `os.homedir()` or a published download root** |
| `setVerbose(on)` | Flip main's live debug-log gate (and the verbose seed for future worker spawns); returns the new state |
| `getIdentityProtection()` | The identity-at-rest protection level (§16) |
| `onMainLog(fn)` | Main-process log lines (only while the debug gate is on); the dev console mirrors them as `[main]` |
| `deepLink.subscribe(fn)` | `mirall://join/<code>` links. First subscribe drains the cold-start queue via `deeplink:flush`. Returns an unsubscribe fn. §5.2 |
| `browseShareFolder()` | OS folder picker (`share:browseFolder`) → absolute dir path or `null` |
| `getBandwidth()` / `setBandwidth(patch)` | Read/persist the content-plane transfer caps (`network.downloadKBps` / `network.uploadKBps` in `config.json`, `0` = unlimited). Main validates and returns the stored value; the renderer then forwards it to the worker as `settings:set-bandwidth` — the same two-step the download folder uses |
| `startOwnedFolderWatcher(shareId, mountPath, ignore)` / `stopOwnedFolderWatcher(shareId)` | Start/stop the chokidar watcher in main (§2 step 12) |

### Renderer ↔ Worker (NDJSON)

One JSON object per line. Requests carry an `id`; events don't. Default request timeout 30 s (`0` for uploads — they stream and must not time out).

**Core requests**

| Type | Payload | Returns |
|---|---|---|
| `shutdown` | `{}` | fire-and-forget; worker exits |
| `profile:get` / `profile:set` | `{}` / `{ displayName, avatar? }` | `Profile \| null` / `Profile` |
| `spaces:list` | `{}` | `Space[]` — rosters are **slim** (`{publicKey, driveKey, displayName, status?}`, no avatars/catalog keys) + `memberCount`/`pendingCount` |
| `space:members` | `{ spaceId }` | `SpaceMember[]` — full self-first roster **incl. avatars** (the only payload carrying them) |
| `space:create` / `space:join` | `{ name, icon? }` / `{ inviteCode, name?, icon? }` | `Space` |
| `space:update` / `space:toggle-favorite` | `{ spaceId, … }` | `Space` — `space:update` also takes `downloadFolder?` (absent = unchanged, `null` = inherit the global root, string = validated per-space override) |
| `space:invite` | `{ spaceId }` | `string` (formatted invite) |
| `space:leave` | `{ spaceId }` | `{ ok:true }` (progress via events) |
| `members:online` | `{ spaceId }` | `publicKey[]` |
| `files:list` | `{ spaceId }` | `FileEntry[]` |
| `files:add` | `{ spaceId, filePath, fileName, fileSize }` | `{ ok:true }` (timeout=0) |
| `files:remove` / `files:discard-partial` / `files:reveal` | `{ spaceId, path }` | `{ ok:true }` — `reveal` spawns `open -R` / `explorer /select,` / `xdg-open` |
| `files:download` | `{ spaceId, driveKey, path }` | `{ transferId }` |
| `files:pause-download` / `files:cancel-download` | `{ transferId }` | `{ ok:true }` |
| `storage:info` | `{}` | `{ totalDiskUsage, storagePath, spaces[], otherBytes }` |
| `storage:cleanup` / `storage:free-space` | `{}` | `{ purged }` / `{ freedBytes }` — `free-space` reclaims resident-cache bytes across every space (called by `StorageSettings.tsx`) |
| `settings:set-download-folder` | `{ folder }` | `{ ok:true }` — relocate the GLOBAL download dir (per-space overrides go through `space:update`) |
| `settings:set-bandwidth` | `{ downloadKBps, uploadKBps }` | `{ ok:true }` — content-plane transfer caps, `0` = unlimited. Applies to **in-flight** transfers: the limiters read their rate per call (§ below) |
| `network:status:get` / `network:reconnect` | `{}` | `{ online, … }` / `{ ok:true }` |
| `feedback:send` | `{ comment, screenshot? }` | `{ ok:true }` — POSTs to `feedback.mirall.app` |
| `ping` | `{}` | `{ pong:true, timestamp }` |
| `audit:list` | `{ spaceId?, kinds?, categories?, actorKey?, search?, since?, until?, cursor?, limit }` | `{ entries[], nextCursor }` — a **partial page with a non-null cursor is normal** (the scan is budgeted) |
| `audit:spaces` / `audit:actors` | `{}` | filter facets read from the **log**, so a left space stays filterable |
| `audit:stats` | `{}` | `{ count, oldestTs, newestTs, oldestSeq, newestSeq }` |
| `audit:get-config` / `audit:configure` | `{}` / `{ enabled?, retentionDays?, maxEntries? }` | `AuditConfig` |
| `audit:purge` | `{}` | `{ purged }` |
| `audit:export` | `{ spaceId?, since?, until? }` | `{ version, exportedAt, entries[] }` — send with `timeout:0` |

**Folder-sharing requests** (§7)

| Type | Payload | Returns |
|---|---|---|
| `share:create` | `{ spaceId, name }` | the share record |
| `share:list` | `{ spaceId }` | `Share[]` (own + every member's, via `listSharesForSpace`) |
| `share:delete` | `{ spaceId, shareId }` | `{ ok:true }` (tombstone) |
| `share:list-files` | `{ spaceId, ownerKey, shareId }` | `[{ relPath, size, hash, mtime, status, localPath? }]` |
| `share:folder-info` | `{ spaceId, ownerKey, shareId }` | `{ fileCount, totalBytes, blobsLength }` |
| `share:read-file` | `{ spaceId, ownerKey, shareId, relPath }` | `{ transferId }` or `{ ok:true, alreadyOwned? }` |
| `share:reveal-folder` / `share:reveal-file` | `{ spaceId, ownerKey, shareId, relPath? }` | `{ ok:true }` |
| `owned-folder:validate` / `foreign-folder:validate` | `{ mountPath, shareId? }` | `{ mountPath, advisories[] }` |
| `owned-folder:preview` | `{ spaceId, shareId, mountPath, ignore?, previewId? }` | `ScanPreview { toUpload, totalBytes, conflicts, existingAtDestination, perFile[], perFileOmitted? }` — **stat-only**, sent with `timeout:0`; streams `event:owned-folder-preview-progress`. `perFile` is omitted (empty + `perFileOmitted:true`) above 50 action-set files |
| `owned-folder:cancel-preview` | `{ previewId }` | `{ ok:true }` — rejects the in-flight walk with `PREVIEW_CANCELLED` |
| `owned-folder:mount` | `{ spaceId, shareId, mountPath, ignore? }` | `{ mount, advisories[] }` (starts watcher + scan) |
| `owned-folder:relocate` | `{ spaceId, shareId, mountPath }` | `{ mount, advisories[] }` (hash-based, no re-upload) |
| `owned-folder:get` / `foreign-folder:get` | `{ spaceId, shareId }` | the mount record or `null` |
| `owned-folder:delete` | `{ spaceId, shareId }` | `{ ok:true }` (unmount + tombstone, cascades to mirrors) |
| `owned-folder:index-status` | `{ spaceId, shareId }` | `{ queued, running, done, failed, totalOnDisk, bytesQueued, order, concurrency }` — the share's publish-queue snapshot |
| `owned-folder:cancel-index` | `{ spaceId, shareId }` | `{ cancelled }` (items dropped; the share stays mounted, status → `active`, periodic reconcile re-armed) |
| `foreign-folder:preview` | `{ spaceId, ownerKey, shareId, mountPath }` | `{ toDownload, totalBytes, … }` |
| `foreign-folder:mount` | `{ spaceId, shareId, ownerKey, mountPath }` | `{ mount, advisories[] }` (starts materialize loop) |
| `foreign-folder:set-enabled` | `{ spaceId, shareId, enabled }` | `{ ok:true }` (pause/resume) |
| `foreign-folder:unmount` | `{ spaceId, shareId }` | `{ ok:true }` |
| `owned-folder:list-all` | `{}` | `[{ …mount, mountPointMissing }]` across all spaces |
| `foreign-folder:list-all` / `mounts:list-all` | `{}` | `ForeignFolderMount[]` / `[{ role:'owned-folder'\|'foreign-folder', … }]` |

The worker also **receives** `event:owned-folder-fs-event { shareId, action, relPath, absPath }` — chokidar events forwarded from main (§2 step 12), handled by `onFsEvent`.

**Events (worker → renderer)**

| Type | Payload |
|---|---|
| `event:state` | `{ profile, spaces }` (initial) |
| `event:profile-needed` | `{}` |
| `event:worker-ready` | `{}` (once, after init) |
| `event:member-joined` / `event:member-left` | `{ spaceId, member }` / `{ spaceId, publicKey }` |
| `event:files-updated` | `{ spaceId }` |
| `event:transfer-complete` | `{ transferId, spaceId, path, localPath }` — notification signal; status re-derives from `files:list` |
| `event:transfer-paused` | `{ transferId, spaceId, path, reason }` — `reason` (`'interrupted'`/`'offline'`) is toast wording only, **never a status source** |
| `event:transfer-error` | `{ transferId, spaceId, path, errorCode, errorMessage }` |
| `event:transfer-superseded` | `{ transferId, spaceId, path, fileName }` |
| `event:leave-progress` | `{ spaceId, step, totalSteps, label }` |
| `event:reconcile` | `{ scope }` — the coalesced, level-triggered "state in this scope changed, refetch it" hint (§4.7), fanned from the named `*-updated` pokes via `POKE_SCOPE` |
| `event:decoration` | `{ channel:'transfer', spaceId, key, bytes, total, speed?, eta?, phase?, verifyFraction?, done? }` — the **one** per-file progress channel (download *and* owner-side publish/prepare, tagged `phase:'publishing'\|'preparing'\|'verifying'`). Loose rows key by drive path, folder rows by `shareId:relPath` (`decoration-key.js`); cleared only by a terminal `done` |
| `event:awareness` | `{ channel:'serving'\|'serving-detail', spaceId, path, … }` — ephemeral "who is downloading" cross-peer soft-state, re-announced on the ledger sweep, expired by a receiver TTL. Never persisted, never a status source |
| `event:audit-updated` | `{}` — poke; fans to `Scope.audit()` so the viewer refetches |
| `event:shares-updated` / `event:share-files-updated` | `{ spaceId }` / `{ spaceId, shareId? }` (shareId absent = space-wide) |
| `event:owned-folder-mount-status` | `{ spaceId, shareId, status, error? }` — `active` / `scanning` / `paused-error` / `mount-point-gone` |
| `event:owned-folder-scan-completed` | `{ spaceId, shareId, uploaded, deleted, totalOnDisk }` — not emitted for a cancelled pass |
| `event:owned-folder-index-progress` | `{ spaceId, shareId, …index-status }` — coalesced (500 ms) while a share's items run; the terminal frame carries the pass's final counts |
| `event:owned-folder-preview-progress` | `{ previewId, phase, scanned, total, bytes }` |
| `event:foreign-folder-mount-status` | `{ spaceId, shareId, status, error?, reason? }` |

### React integration

| Hook | Requests | Subscribes to |
|---|---|---|
| `useProfile` | `profile:get`, `profile:set` | `event:profile-needed` |
| `useSpaces` | `spaces:list`, `space:create`/`join`/`leave`/`invite`/`update`/`toggle-favorite` | `event:state`, `event:reconcile` (members/join-requests), `event:membership-granted`/`-denied`/`-creator-divergence` |
| `useFiles(spaceId)` | `files:list`/`remove`/`download`/`cancel-download`/`discard-partial`/`reveal`, uploads via `addFileToSpace()` | `event:reconcile` (files + members), refreshes coalesced (750 ms leading+trailing); publish/prepare progress from `useDecorations` |
| `useMembers(spaceId)` | `space:members`, `members:online`, `space:pending-requests` | `event:reconcile` (members + join-requests) |
| `useSpaceMembers(spaceId)` | `space:members` (module-cached full roster for card facepiles) | `event:reconcile` (members) |
| `useUpdates` | — (passive: staged update + `dismiss`) | `bridge.onPearEvent('updated')` via `updates.ts` |
| `useShares(spaceId, myKey)` | `share:list`, `owned-folder:list-all`, `foreign-folder:list-all` → derives `ShareWithRole[]` (`mine`/`browse`/`mirrored`) | `event:reconcile` (shares — owned + foreign mount-status both fan a shares hint) |
| `useShareFiles(spaceId, ownerKey, shareId, role)` | `share:list-files`, `share:folder-info`, `share:read-file`, `share:reveal-file` | `event:reconcile` (share-files + files); progress from `useDecorations` |
| `useDecorations(channel, spaceId)` | — | `event:decoration` — merge-by-key progress map, cleared only by `done` |
| `useOwnedMount` / `useForeignMount` (`hooks/useFolderMount.ts`) | `{owned,foreign}-folder:get` + `validate`/`preview`/`mount`(/`set-enabled`/`unmount`) helpers | `event:{owned,foreign}-folder-mount-status` |
| `useIpcQuery` | generic `request()` wrapper | — |

### Developer console (`window.mirall`)

`src/renderer/dev-console.ts` (imported unconditionally by `main.tsx`) exposes a debugging surface on `window.mirall` — **present in every build, including production**, reachable through DevTools (§2 step 6). Read-only diagnostics go through the worker RPC (`request`); logging/version/update/identity go through `window.bridge`. Every command logs its result *and* returns it, so both `mirall.spaces()` and `const s = await mirall.spaces()` work. Typed as `MirallDevConsole` in `global.d.ts`.

`help()` · `verbose(on = true)` — flips verbose logging across **worker and main at runtime**, no relaunch, no env var · `status()` (`network:status:get`) · `spaces()` · `members(spaceId)` (`members:online`) · `storage()` · `mounts()` (`mounts:list-all`) · `profile()` · `features()` (`features:get`) · `version()` (`bridge.appVersion()`) · `update()` (`bridge.checkForUpdate()`) · `identity()` (`bridge.getIdentityProtection()`).

---

## 9. Update System

Driven by `pear-runtime-updater` (a dependency of `pear-runtime`), which watches the channel Hyperdrive identified by `package.json#upgrade`.

1. **Drive subscription.** Main constructs `PearRuntime({ upgrade, store, swarm, version, … })`. The runtime opens a Hyperdrive against the upgrade key and joins its discovery key as a swarm client. Every append to the drive's metadata core fires the updater's debounced `_update`.
2. **Version check.** `_update` reads `/package.json` from the latest checkout and parses `version` as semver. Strictly greater than the running version ⇒ proceed. **Equal** ⇒ prefetch the binary so apply is instant when triggered. Otherwise return silently.
3. **Mirror.** Iterate `co.list('/by-arch/<host>/app/<name>')` — `host = process.platform + '-' + process.arch`, `name = Mirall.app | Mirall.AppImage | Mirall.msix` — into `<userData>/pear-runtime/next/<length>.<fork>/by-arch/<host>/app/<name>`.
4. **Events.** `pear.updater.emit('updating')` on mirror start, `'updated'` on completion; both forwarded to the renderer as `pear:event:updating` / `pear:event:updated`.
5. **Banner.** `renderer/updates.ts` listens for `updated`. Dev builds reload the window. Packaged builds read the staged version via `bridge.appVersion()` — **from main**, because the worker's bootstrap fork/length snapshot can be a stale `0/0` before replication completes — and store it through the `updateState` reducer. `UpdateBanner` (inside `TopNav`) is passive: *"Update to vX available — applied on next start"* plus **Dismiss**. Dismissing hides the banner; the About screen keeps showing the notice.
6. **Apply — no user action.** `pear.updater.applyUpdate()` runs automatically:
   - **Windows / Linux** — main pre-stages the apply the moment `updated` fires. On Windows because `msix-manager.addPackage` takes seconds and would race a quit→relaunch inside `before-quit`, silently failing if the `.msix` is still locked. On Linux so the staged AppImage doesn't sit unused until a clean quit.
   - **macOS** — applies only at quit: a mid-session `fsx.swap` would let a later disk re-read mix new-version files with old in-memory code.
   - **All platforms** — a `before-quit` hook promotes any staged-but-unapplied bundle: `event.preventDefault()` → `await applyUpdate()` → re-`quit()`, because **Electron does not await async listeners** and the swap must finish before exit.

   Mechanics: macOS/Linux `fsx.swap(nextApp, this.app)` atomically exchanges `/Applications/Mirall.app` (or the AppImage path) with the mirrored bundle, then `rm -rf next/<length>.<fork>`. Windows `msix-manager.addPackage(nextApp, { forceUpdateFromAnyVersion: true })` re-registers over the existing install. Main wraps `applyUpdate` with `process.noAsar` scoping (Electron would otherwise choke on the half-written `app.asar` in the mirror destination), a pre-swap `chmod 0o755` of the staged AppImage (`localdrive` preserves the executable bit only when the drive entry carries `executable:true`), and apply-error recording to `pear-runtime/last-apply-error.json`, cleared on the next successful apply.
7. **Next start runs the new version.** There is no in-app relaunch — the swap already happened in the background or completed during quit.

Version coupling: the bundled CI version must equal the drive's `/package.json#version`, so a freshly-installed build and the staged drive compare equal (`current.compare(remote) === 0`) and the updater early-returns instead of looping an update banner on every launch. → `build-process.md`.

`pear.updater.on('error', …)` is wired in `getPear()` so any updater-side rejection surfaces as `pear updater error: …` on stderr instead of a swallowed promise rejection. A global `unhandledRejection` handler is registered for the same reason.

Diagnostic IPC (`bridge.checkForUpdate()`, `bridge.appVersion()`) is catalogued in §8.

---

## 10. UI Structure

**Visual language — colour tokens, typography, spacing, radii, elevation/glass, motion, platform chrome, and the styling of every component — lives in `design.md` and is authoritative there.** This section covers only structure and behaviour.

The design system is named **"Editorial Etherealism"**. `src/renderer/platform.ts` stamps `data-platform="darwin|win32|linux|other"` on `<html>` at load, which drives platform-specific chrome. Window bounds persist across launches via `renderer/window-bounds.ts` + `bridge.getWindowBounds`/`setWindowBounds`.

### Internationalization

`renderer/i18n.ts` initialises `i18next` + `react-i18next` with five locales (`en`, `de`, `fr`, `es`, `it`). Catalogs live at `renderer/locales/<code>/{common,errors}.json` and are **statically imported** so esbuild bundles them — no runtime fetch.

Initial language: persisted choice from the unified config (`config-client.ts`, hydrated synchronously from `bridge.getConfig()`) → else `bridge.getLocale()` (Electron's `app.getLocale()`) reduced to its primary subtag → else `en`. `setLocale(code)` persists via `config-client` (→ `config:set`) and calls `i18n.changeLanguage()`; `document.documentElement.lang` stays in sync. Components use `useTranslation()`. `SUPPORTED_LANGUAGES` is exported for the language picker.

Adding a locale: drop `locales/<code>/{common,errors}.json`, add a `SUPPORTED_LANGUAGES` entry, register the imports in `i18n.ts`.

> **German UI convention: generic masculine.** Never propose `Kolleg:innen` / `Mitglied*innen` or similar inclusive-language forms.

### Screens

| Screen | Trigger | Key components |
|---|---|---|
| **Onboarding** | First launch (no profile) | Avatar upload (`CrystalBackdrop` + `IconPicker`), display-name input |
| **Shared Spaces** | Default after onboarding | `SpaceCard` grid, Create/Join, empty state |
| **Space View** | Click a space | A **Folders Shared** section (`ShareCard` grid — one per owned/mirrored/browsable share) above the loose-files grid (`FileCard`s), plus a sidebar (`DropZone`, `StorageIndicator`, `MemberCard`s, invite + edit + leave). Dropping a *folder* (or `⌘⇧U`) opens `AddFolderShareModal`; clicking a `ShareCard` navigates to Folder View |
| **Folder View** | Click a `ShareCard` | Full-screen browse of one share (`screens/FolderView.tsx`): file rows with per-file download/reveal + progress, an owner/role sidebar, and role-dependent actions — **Mirror to Disk** (browse), pause/resume + unmount (mirrored), relocate + **Delete Folder** (owned) |
| **Activity Log** | Account → Activity | The audit-log viewer: search, space/person/time/category filters, day-grouped rows, Load more. Cross-links to its settings |
| **Activity Log settings** | Settings → Activity Log | Recording toggle, retention, JSON export, delete. Cross-links back to the viewer |
| **Settings** | Gear icon | Profile edit, theme toggle, nav to Storage / Activity Log / About |
| **Storage Settings** | From Settings | `StorageIndicator` per space, total / other breakdown, cleanup → `storage:cleanup` |
| **About** | From Settings | Version info, "Send feedback" → `FeedbackModal` |

Modals rendered from root: `FeedbackModal` (comment + `modern-screenshot` capture via `feedback:send`).

### Toast notifications

The in-app transient-feedback primitive for **foreground** actions. `renderer/components/toast/` — `ToastProvider` (context + state + timers), `ToastContainer` (fixed stack at `z-[60]`, above modals at `z-50`), `Toast`, `useToast`, `types.ts`. Mounted as the **outermost** provider in `app.tsx` so any descendant — including modals — can raise one.

Four variants: `error` / `warning` / `success` / `info`. Behaviour: stacks up to 4 visible (oldest dropped on overflow), dedupes by stable `id` (same id replaces in place), auto-dismisses after a configurable duration, pauses the timer on hover and resumes on leave, optional inline action button. Styling, motion, and ARIA roles → `design.md`.

**Toasts vs OS notifications.** Deliberately separate systems. Toasts = foreground feedback on something the user *just did* (folder dropped that we don't accept, validation failed, action confirmed). OS notifications (`bridge.notify` → `main/notifications.js`, §8) = background events the user may not be watching (transfer complete, peer joined). Different IPC, different OS muting rules, different ARIA semantics. **New error-surfacing code defaults to toasts** unless the event is genuinely async-and-passive.

**Dev hook.** When `bridge.isDev()` is true, `ToastProvider` attaches its API to `window.__toast` for console testing (`__toast.error('…')`). Packaged production builds never set the global — the main-process handler returns `false` when `app.isPackaged && !PEAR_DEV_SERVER_URL`. Typed via `declare global { interface Window { __toast?: ToastApi } }`, so no `any`/`unknown` casts.

Current consumer: `DropZone` (folder-drop rejection, via `webkitGetAsEntry().isDirectory`).

### Component library

Tailwind + React Aria. Since the #199 reorg, grouped under `renderer/components/`: `primitives/` (Button, IconButton, Toggle, Badge, Avatar, Icon, Modal, ProgressBar, StatusBadge, CopyButton), `cards/` (FileCard, MemberCard, ShareCard, SpaceCard), `modals/`, `layout/` (TopNav, UpdateBanner, PageHeader, SectionHeading), `widgets/` (ActionMenu, DropZone, StorageIndicator, IconPicker, FilePath, NetworkStatusIndicator, CrystalBackdrop, ConnectivityToastBridge, DownloadProgressLane), `toast/`.

Behaviour worth knowing (styling → `design.md`):

| Component | Behaviour |
|---|---|
| `TopNav` | Logo, update-banner slot, settings + feedback buttons, profile avatar |
| `UpdateBanner` | Staged version + "applied on next start" + Dismiss. Publishes its height as `--banner-h` so screens shift down instead of being overlaid |
| `SpaceCard` | Icon tile + member avatars + active badge + favourite toggle |
| `CreateSpaceModal` / `EditSpaceModal` | Name + `IconPicker`; edit also surfaces Leave |
| `JoinSpaceModal` | Invite-code input + optional local name + icon |
| `LeaveSpaceModal` | Undownloaded-file warning + progress bar driven by `event:leave-progress` |
| `InviteModal` | Copy the invite code for an existing space |
| `DropZone` | Drag-and-drop + file picker. Files → `addFileToSpace`; a dropped **folder** → `AddFolderShareModal`. Rejects ephemeral/promised drop sources (`temp-paths`) |
| `FileCard` | Renders the file states of §3.5; per-state action button (Download / Cancel / Resume / Discard / Reveal / Remove) |
| `ActionMenu` | The dropdown-button primitive (react-aria menu, portalled popup). Three triggers: `primary` (labelled key action — Space View / Folder View "More"), `subtle` (icon-only three-dot — `ShareCard`), `neutral` (labelled, secondary-button tokens — the Activity Log filter bar, where several menus sit together and none is the screen's main action). Items may omit `icon`, which single-choice menus use to check only the selected row |
| `RemoveFileModal` | Delete confirmation with a "members keep their copy" warning |
| `StorageIndicator` | Local-mirror progress bar (Space View + Storage Settings) |
| `FeedbackModal` | Textarea + optional screenshot toggle; POSTs through `feedback:send` |
| `IconPicker` | Material Symbols picker for space create/edit |
| `ShareCard` | One folder share — name, owner avatar, role badge (Shared by you / Mirrored / Browse), mount status, action menu (mirror, pause/resume, locate, unmount, delete) |
| `AddFolderShareModal` | Two-step owner flow (edit → preview): pick a folder (`browseShareFolder`), name + validate, preview the scan, then `createShareThenMount` — **rolls the share back if the mount fails** |
| `MirrorFolderModal` | Two-step consumer flow: owner + folder size (`share:folder-info`), pick a destination, always show the read-only warning, then `createForeignMount` |
| `ScanPreviewModal` | Shared preview step for add-folder / mirror / relocate — summary cards (to-upload / to-download / conflicts / already-present) + collapsible per-file list |
| `DeleteFolderShareModal` | Owner-side confirm for `owned-folder:delete` (warns it removes the share for everyone and stops mirrors) |
| `PageHeader` | Back button + title + optional subtitle (Folder View, settings sub-screens) |
| `ProgressBar` | Non-cancellable (the caller owns controls) — used for mirror file rows |
| `FilePath` | Monospace path, middle-truncated (directory ellipsizes, filename stays) via `splitPathForDisplay()` in `renderer/sharePaths.js`. Renders FS paths consistently everywhere |
| `IconButton` | Circular icon-only button with a **mandatory** `ariaLabel` |

---

## 11. Module Structure

| Path | Purpose |
|---|---|
| `src/main/main.js` | Electron main. Argv, BrowserWindow, PearRuntime bootstrap, OTA wiring, worker IPC bridge, `mirall://` deep-link dispatch (§5.2), lifecycle, asar `spawn` shim (§2 step 10) |
| `src/preload/preload.js` | `contextBridge.exposeInMainWorld('bridge', …)`. The only file touching both Electron internals and the renderer window |
| `src/main/config-store.js` | The single owner of `config.json` — atomic writes, merge-over-defaults, migration seam (§2 step 5) |
| `src/main/notifications.js` | Native `Notification` IPC + `shell:showInFolder` |
| `src/main/deeplink.js` | `parseDeepLink(url)` — validates `mirall://join/<code>`, decodes the envelope (dynamic import, since main is CJS) |
| `src/main/owned-folder-watchers.js` | chokidar watchers for owned-folder shares (§2 step 12, §7) |
| `src/main/loose-file-watchers.js` | chokidar host for in-place loose-file shares (§2 step 12) |
| `src/worker/main.js` | Bare worker entry — wires `Bare.IPC` to `core/ipc.js`, registers the handlers, shuts down on parent disconnect |
| `src/worker/boot.js` | The composition root — `bootDurable()` (the tier that outlives the network teardown) plus the runtime tier; starts them in order, closes them in reverse |
| `src/worker/mounts-runtime.js` | `MountsRuntime` — owned/foreign mount resume, durable status, the periodic reconcile timers, the mount + download-root probe |
| `src/worker/sweeps.js` | `Sweeps` — the presence, invite-expiry and audit-prune backstops |
| `src/shared/core/subsystem.js` | `Subsystem extends ReadyResource` (owned timers, `require()`, `stopping`) + `createLifecycle()`, the ordered start/close registry |
| `src/shared/core/store.js` | Corestore init, `createBee()` / `createDrive()` factories, and the `Store` resource that owns the store's lifetime + `openSessionNames()` |
| `src/shared/transfer/backends/overlay/overlay-runtime.js` | `OverlayBackend` — the overlay instance, the serve index and both download engines as one lifetime; outside the package's import cycle so wiring them together adds no edge to it |
| `src/shared/core/timers.js` | `createTimers()` — an owned timer set that clears on close and refuses to schedule after it |
| `src/shared/core/intents.js` | `createIntentLog()` — durable intent records + the per-kind reconcilers boot dispatches |
| `src/shared/core/lru.js` | `createRefCountedLru()` — bounded cache of live handles; an entry with readers is never evicted |
| `src/shared/contract/` | The vocabulary all three runtimes share — requests, codes, events, limits, statuses, scope, audit kinds. Zero imports, by rule |
| `src/shared/core/handler-table.js` | `createHandlerTable()` + `validateArgs()` — each request's function beside its declared shape |
| `src/shared/spaces/leave-flow.js` | `runLeaveTeardown()` — the one teardown ORDER the live leave and the boot pass share |
| `src/worker/ipc/space-leave.js` | `registerSpaceLeave(ipc, deps)` — the space:leave handler as a module, the first seam out of the entrypoint |
| `src/worker/package.json` | `"type": "module"` so Bare imports the worker as ESM |
| `src/shared/` | Worker data layer (below); `invite-envelope.js` is also dynamically imported by main |
| `src/renderer/` | Renderer source (TS + React → `assets/dist/`) |
| `assets/` | Shipped renderer assets: `index.html`, `fonts/`, `theme-bootstrap.js` (pre-paint dark-mode, no FOUC), esbuild/Tailwind output in `dist/` |
| `resources/` | Platform build assets per target: `darwin/` (`icon.icns`, `entitlements.plist`, `dmg/`), `win32/` (`icon.ico`, `AppxManifest.xml`, `msix-assets/`), `linux/` (`AppRun`, `icon.png`, `icons/`), `tray/` |
| `forge.config.js` | electron-forge config — packagerConfig, makers, the `afterCopy` hook that injects `UPGRADE_KEY` into `package.json#upgrade`, MSIX manifest version patching |
| `seed-host/` | Seed-host scripts, systemd units (`mirall-seed.service` + the disabled `mirall-seed-staging.service`), the `pearel-systemctl` sudoers fragment, `README.md` + `setup-guide.md`. Pipeline → `build-process.md`; host setup → `seed-host/README.md` |
| `scripts/` | Local build / signing / diagnostics — `generate-tray-icons.mjs`, `export-translations.mjs`, `build-app-image.sh`, `sign-windows-local.ps1`, `uninstall-windows.ps1`, `uninstall.sh`, `inspect-store.mjs`, `check-comment-hygiene.sh` |
| `test/` | Test suite — a CI gate. §15 |
| `eslint.config.mjs` | Flat config incl. `eslint-plugin-jsx-a11y` (a `npm run build` / CI gate) |
| `tailwind.config.js` | Design tokens + content globs |
| `tsconfig.json` | `target: ES2022`, `jsx: react-jsx`, `rootDir: src/renderer`, `outDir: assets/dist` — **typecheck only**; esbuild is the bundler |

### `src/shared/` — worker data layer

Since the #199 reorg, split into domain subfolders. `invite-envelope.js` stays at the root as the one module reached across processes.

| File | Purpose |
|---|---|
| `core/runtime-config.js` | Bootstrap config getter/setter; also centralizes DoS/resource budgets (§16) and `getListFilesCap()` |
| `core/errors.js` | `AppError`, `ErrorCodes`, `classifyTransferError`, `isRetryableTransferError`, `friendlyTransferError` |
| `core/ipc.js` | NDJSON router + pre-start message queue; `POKE_SCOPE` fan-out (§4.7). Wraps `Bare.IPC` |
| `core/logger.js` | Scoped logger, `--verbose` gated (default level: warn) |
| `core/store.js` | Corestore init, `createBee()` / `createDrive()` factories |
| `core/channel.js` | `deriveChannel({dev, appVersion})` → `dev`/`staging`/`prod`. Dependency-free so it's unit-testable; consumed by `telemetry/feedback.js` |
| `core/paths.js` | `getDownloadDir()` + download-path resolution |
| `core/with-timeout.js` | `withReadTimeout(promise, ms, fallback)` — bounds peer reads so one offline peer can't stall aggregation |
| `core/unlock-providers.js`, `identity-envelope.js`, `identity-resolve.js`, `identity-keys.js` | M / KEK wrap-unwrap and key derivation (§16) |
| `spaces/space.js` | Space metadata, invite-code format, drive open/purge, `purgeCoreDk()` RocksDB tombstone writer |
| `spaces/profile.js` | Profile-bee CRUD + `openProfileBee(key)` for peer avatars/manifests |
| `shares/shares.js` | Share-record CRUD on the profile bee: `publishShare`, `tombstoneShare`, `readOwnShares`, `readPeerShares`, `readPeerShareEntry` (raw — sees tombstones), `isValidShareName`, `ensureSharesCap` |
| `shares/share-registry.js` | `listSharesForSpace(spaceId)` — aggregates own + every member's peer shares into one list tagged with `owner`/`source` |
| `shares/share-catalog.js` | Per-owner replicated catalog the overlay advertises into / lists from: `advertise`, `tombstone`, `listOwnShare`, `listPeerShare`, `watchPeerCatalog`, `openPeerCatalog` |
| `folders/owned-folders.js` | Owner-side folder producers: `onFsEvent`, `initialPublishScan` / `periodicReconcile` (diff → enqueue → drain), `previewInitialPublishScan`, the catch-up debounce, `getIndexStatus` / `cancelIndex`, `stopOwnedFolder`. Registers the `folder` channel. §7.2 |
| `folders/work-item.js` | The path-keyed work item, priorities, ordering comparators (`PUBLISH_ORDERS`). Pure. §7.2 |
| `folders/publish-queue.js` | One space's queue: heap in the configured order + byKey map (one live item per path; fold / supersede / cancel). Pure. §7.2 |
| `folders/publish-scheduler.js` | Cross-space runner: bounded slots, round-robin, the space and interactive reservations, tallies, `whenDrained`. Pure. §7.2 |
| `folders/publish-service.js` | The shared owner-side lane: the scheduler singleton, the per-space catalog batch (`catalogFor` / `settleCatalog` / `closeBatch`), the channel registry (`registerPublishChannel` / `channelFor`), space/global stop. Owned folders and loose files both enqueue here. §7.2 |
| `folders/publish-runner.js` | The executor: dispatches on the item's share id (`channelFor`) to its channel — `resolve` (mount + root guard + path, or the loose source link), exact-name re-stat before a retire, then the channel's `publish` / `retire`. §7.2 |
| `core/coalescing-runner.js` | Per-key single-flight with one queued rerun that absorbs every request arriving mid-run; guards the owned-folder diff. |
| `folders/foreign-folders.js` | Consumer-side sync: `startForeignLoop`/`stopForeignLoop`, `runMaterializeTick` (30 s poll, serialized per mount), `applyChange`, `initialMaterializeScan`, `onPeerDriveChanged`. §7.3 |
| `folders/mount-store.js` | `mounts-meta` CRUD for both mount kinds (`saveOwnedMount`, `getForeignMount`, `listOwnedMounts`, `listForeignMounts`, `findOwnedMountByShareId`, …). §3.6 |
| `folders/mount-validate.js` | `validateMountPath` — reject/advisory rules. §7.4 |
| `folders/path-keys.js` | Pure cross-platform path math + ignore-globs + mount-safety helpers. §7.5 |
| `folders/echo-guard.js` | Per-share TTL set of paths we just wrote, so the watcher ignores our own writes |
| `folders/temp-paths.js` | `isEphemeralSourcePath()` — rejects macOS promised-file temps as share/drop sources |
| `transfer/files.js` | File listing (state resolver over the loose catalog), reveal, downloaded-file verification + history, owned-source map |
| `transfer/loose-overlay.js` | In-place loose files served over the overlay instance: admission (name + cap under the space lock), the `loose` publish channel (source-link resolve, `publishing` decoration, watch arming, direct unshare), boot rehydrate and presence sweep as producers into the publish service; the consumer side rides the shared download engine |
| `transfer/content-backends.js` | The seam: `getContentBackend(share)` → overlay, else `UNSUPPORTED`. Locked by `content-backend-conformance.test.js`. §7.7 |
| `transfer/backends/overlay/` | `overlay-backend.js` (the 7-method content contract: one file's hash, catalog entry, serve registration, fetch), `overlay-instance.js` (`HyperOverlayV2` lifecycle + channel attach; feeds the serve ledger), `overlay-download.js` (shared consumer engine), `overlay-authorize.js` (the three serve gates, §16), `vendor/` (vendored `hyper-overlay` v2 subset + `PROVENANCE.md`) |
| `transfer/serve-ledger.js` | Sender-side download indicator: who is pulling a file we own and how far — summary tier (always on) + per-peer detail tier (only while a row is subscribed), idle/paused sweeps, audit `serve.completed` sessions. Fed by `overlay-instance.js`, read via `serving:*` IPC. Not a backend concern; `initServeLedger(ipc)` in the worker. |
| `transfer/download-dest.js` | `resolveDest` — collision-free Downloads naming |
| `transfer/partial-sweep.js` | `cleanupOrphanedPartials` — boot sweep of unreferenced partials |
| `transfer/transfer-status.js` | `pausedStatusFor` — derives a row's paused sub-status |
| `transfer/pending-transfers.js` | Pending-transfers bee CRUD (resume across restarts) |
| `transfer/swarm.js` | Hyperswarm + Protomux handshakes, per-space identity binding (§16), overlay channel attach, presence/membership gossip |
| `transfer/handshake-guard.js` | Verifies the identity binding on every identity-asserting frame (§16) |
| `transfer/sck-seal.js` | Seals the SCK to a joiner's bound signer key at approval (§16) |
| `transfer/progress-ticker.js` | `makeProgressTicker(total, emit)` — 250 ms-throttled `{bytes,total,speed,eta}`; shared by single-file transfers and folder mirroring |
| `state/presence.js`, `state/hints.js` | Presence leases; coalesced `event:reconcile` hints. §4.7 |
| `storage/storage.js` | Per-space byte accounting + orphan-core cleanup |
| `audit/audit-kinds.js` | The closed audit vocabulary + category/tier tables. Pure |
| `audit/audit-record.js` | `buildRecord()` — schema v1, name snapshots, search blob. Pure |
| `audit/audit-retention.js` | Prune-boundary math incl. the clock-jump hysteresis. Pure |
| `audit/audit-sessions.js` | Folds start/end activity into one row per transfer. Pure |
| `audit/audit-log.js` | The `audit-log` bee: `record`, `queryAudit`, prune/purge/export, config, and the peer-bee watermarks. Imports only from `core/` so the instrumentation call sites can't form a cycle |
| `audit/peer-observer.js` | Pure diff of a peer's bee: key classification, the fingerprint dedupe, and the bounded history read. No I/O |
| `audit/peer-watch.js` | Wires that diff into the data layer — name resolution, the relevance gates, and the registration-time baseline |
| `telemetry/feedback.js` | HTTPS POST (via `bare-https`) of the feedback caption + optional screenshot. Sends `x-mirall-install-id`, `x-mirall-version`, `x-mirall-channel` |
| `telemetry/install-id.js` | Lazily mints + persists an opaque per-install UUID at `<storage>/install-id`, for rate-limit bucketing on the relay |
| `invite-envelope.js` *(root)* | `encodeInvite` / `decodeInvite`, v0 + v1. ESM, dynamically imported by `main/deeplink.js`. Twin of `renderer/invite-envelope.ts`. §5.1 |

### `src/renderer/`

| File / dir | Purpose |
|---|---|
| `main.tsx` | `createRoot(…)`; imports `platform.ts`, `theme.ts`, `dev-console.ts` for side effects |
| `app.tsx` | Root — screen routing, theme init, window-bounds restore, deep-link queue, outermost `ToastProvider` |
| `ipc.ts` | Worker IPC wrapper — `request()`, `subscribe()`, `addFileToSpace()` |
| `updates.ts` | Singleton update state → `UpdateBanner` |
| `config-client.ts` | Synchronously-hydrated cache of the renderer slice of `config.json`; writes via `config:set` |
| `types.ts` | `Profile`, `Space`, `SpaceMember`, `FileEntry`, `FileStatus`, `Transfer`, `UpdateInfo`, plus folder-sharing types (`Share`, `ShareRole`, `ShareWithRole`, `OwnedFolderMount`, `ForeignFolderMount`, `ShareFileEntry`, `MountValidationResult`, `ScanPreview`, …) |
| `sharePaths.js` | `splitPathForDisplay()` — middle-truncation math for `FilePath` |
| `errorMessages.ts` | Backend error codes (incl. `MOUNT_*`) → i18n keys via `mountErrorI18nKey()` |
| `keyboard/` | `KeyboardProvider` + `registry`, `accelerator` (chord parsing) + `AcceleratorLabel`, `CommandPalette` (`⌘K`), `ShortcutsHint`, `known-commands.ts`. Screens register via `useRegisterCommand` (SpaceView: `⌘U` add files, `⌘⇧U` add folder, `⌘J` join, `⌘⇧L` leave) |
| `utils.ts` | `formatSize` / `formatSpeed` / `formatEta` / `getFileIcon` / `resizeAvatar` / `fileName` / `gradientForSpaceId` |
| `platform.ts` / `theme.ts` / `window-bounds.ts` | `data-platform` stamp; dark-mode persistence; bounds restore/track |
| `dev-console.ts` | `window.mirall` debugging surface (§8) |
| `global.d.ts` | Type declarations for `window.bridge` |
| `hooks/` | `useIpc`, `useProfile`, `useSpaces`, `useFiles`, `useMembers`, `useSpaceMembers`, `useDecorations`, `useUpdates`, `useShares`, `useShareFiles`, `useFolderMount`, `useForeignMount` |
| `screens/` | `Onboarding`, `SharedSpaces`, `SpaceView`, `FolderView`, and the settings family — `Settings` (shell) + `Account` (the Profile page: profile, this device, app info), `AppearanceSettings`, `GeneralSettings`, `NotificationSettings`, `NetworkSettings`, `NetworkStatus`, `StorageSettings`, `ActivityLog`, `ActivityLogSettings` |
| `components/` | `primitives/`, `cards/`, `modals/`, `layout/`, `widgets/`, `toast/` (§10) |
| `styles/tailwind.css` | Font faces, custom utilities, glass classes → `design.md` |
| `i18n.ts` | `i18next` setup, initial-locale resolver, `setLocale`, `SUPPORTED_LANGUAGES` |
| `invite-envelope.ts` | TS twin of `shared/invite-envelope.js`. §5.1 |
| `locales/<code>/{common,errors}.json` | Catalogues, statically imported so esbuild bundles them |
| `notifications/` | `dispatcher.ts` (suppress-when-focused gate + `bridge.notify`), `click-router.ts` (`bridge.onNotificationClick` → focus + routing). OS-level — distinct from in-app toasts |

---

## 12. Dependencies

**`package.json` is the single source of truth for versions.** Versions are deliberately not restated here — they drift with Renovate, and a stale copy is worse than no copy. Bump procedure → `dependency-updates.md`.

Only the non-obvious constraints are recorded:

| Dependency | Constraint |
|---|---|
| `pear-runtime` | **Exact pin, no caret.** It carries `pear-runtime-updater` transitively; a surprise minor can change OTA behaviour |
| `chokidar` | **Electron main only, never the worker** — Bare has no native recursive watch (§2 step 12) |
| `bare-fs` / `-path` / `-os` / `-subprocess` / `-https` | Bare stdlib. Worker only — these are *not* Node modules |
| `hypercore-storage` | Pulled in for the low-level RocksDB key layout `purgeCoreDk()` writes tombstones against (§6). Upgrades can change that layout |
| `bare-runtime` | Bare VM for `test:bare` + the flow layer's worker subprocesses. A `postinstall` symlinks `node_modules/.bin/bare` |
| `eslint-plugin-jsx-a11y` | A build + CI **gate**, not advisory (§15) |
| `@axe-core/react` | Dev-only runtime a11y checker; logs WCAG violations, not CI-blocking |
| `electron` | A devDependency — forge bundles it into the artifact |

---

## 13. Build & Distribution Pipeline

**The release pipeline (CI channel/version resolution, R2 upload, seed-host deploy, MSIX signing ceremony, snapshot creation + rotation) lives in `build-process.md` and is authoritative there.** This section covers only what the *application source* has to know.

Backup posture, for the record: prod releases snapshot the whole seed VM disk (including the live corestore) via `release.sh`; disaster recovery is "restore that snapshot in the Hetzner UI." Dev/staging deploys do **not** snapshot — those drives are regenerable from source. No in-VM tarballs are made and no data is rsync'd to dev machines.

### Renderer build

```
src/renderer/**/*.ts(x)          ─tsc --noEmit──────►  typecheck only
src/renderer/main.tsx            ─esbuild───────────►  assets/dist/main.js   (bundled, minified, sourcemap --sources-content=false)
src/renderer/styles/tailwind.css ─@tailwindcss/cli──►  assets/dist/app.css   (--minify)
```

- `npm run build` → typecheck + bundle JS + bundle CSS + lint
- `npm run dev` → esbuild watch + tailwind watch + `npx serve -l 5173 assets` + `electron-forge start --no-updates` (via `PEAR_DEV_SERVER_URL`)
- `npm run typecheck` → `tsc --noEmit`
- `npm test` → `test:node && test:bare` (§15)

### Linux AppImage

`electron-forge package --platform=linux` produces an unpacked tree; `scripts/build-app-image.sh` assembles the `.AppImage` via `app-builder-lib`. It bundles a custom `resources/linux/AppRun` that exports library paths and exec's the binary with `--no-sandbox`.

After `app-builder` finishes, the script **swaps the stock libfuse2-based AppImage runtime for `VHSgunzo/uruntime` in extract-and-run mode (`URUNTIME_MOUNT=0`)**, so the AppImage runs on Ubuntu 24.04 / Fedora 40+ where `libfuse2` is no longer installed by default. Pinned by the `URUNTIME_VERSION` constant in `build-app-image.sh`; bump by editing that line and triggering a dev build.

### Asar packaging

`forge.config.js` packages with `asar: { unpack: '*.{node,bare}', unpackDir: '{src/worker,src/shared,node_modules,resources}' }`. Host code lands in a sealed `app.asar` (~3 MB); everything else materialises into a sibling `app.asar.unpacked/`.

The asar **is not compressed** — the goal is binary form + light obfuscation, not size reduction. Disk usage is unchanged from a loose-files layout. Extracting it takes `npx @electron/asar extract`.

| | Contents |
|---|---|
| **Inside the archive** | `src/main/`, `src/preload/`, `assets/index.html`, `assets/dist/{main.js,app.css}`, `assets/fonts/`, `assets/theme-bootstrap.js`, `package.json` |
| **Unpacked** (forced onto the real FS) | `src/worker/`, `src/shared/`, `node_modules/**` — **Bare is a separate C runtime with no asar awareness**; it can't read `.bare` modules, JS sources, or the worker entry from inside an archive, and `bare-sidecar` `chmod`s its own `bare` binary on first launch, which fails on a read-only asar path. All `*.{node,bare}` files — `dlopen` / Bare's loader can't read from asar. The whole `resources/` dir — per-platform Notification + tray icons go to native APIs (`NSImage` / Toast / libnotify) that don't traverse asar (`nativeImage.createFromPath` was rejected: it decodes only PNG/JPEG, not `.icns`/`.ico`) |
| **Fully ignored** | `resources/darwin/dmg/`, `resources/darwin/entitlements.plist`, `resources/win32/AppxManifest.xml`, `resources/win32/msix-assets/`, `resources/linux/AppRun`, `resources/linux/icons/` — package-time-only inputs, read by forge makers and `build-app-image.sh` from the source tree, never from the shipped bundle |

Asar also forces the spawn shim in `src/main/main.js` (§2 step 10): `require.resolve()` returns asar paths, but `child_process.spawn` hands paths straight to the OS, which can't walk into a flat archive. The shim rewrites `app.asar/` → `app.asar.unpacked/` for both executable and argv, fixing the bare-binary spawn and the worker-entry argument in one place.

OTA is unaffected: the channel drive ships the whole `.app` / `.AppImage` / `.msix` (which contains both `app.asar` and `app.asar.unpacked/`), and `fsx.swap` operates on the bundle root.

---

## 14. Known Limitations & Future Work

- **Invite links gate reading, not knocking.** The topic inside an invite is a discovery capability: anyone holding a code can join the swarm topic and send join requests until the link expires or is revoked (`invite-envelope.js` carries expiry + auto-approve policy; `revokeInvite` kills a link). Read access always requires approval — the SCK handout (§16).
- **Checksum-failed transfers need manual intervention.** Transfers auto-pause and auto-resume across owner offline/reconnect, but one that failed its integrity check (`TRANSFER_CHECKSUM`) is never auto-resumed — re-fetching from the same holder would fail identically — so it waits for an explicit resume or discard (`overlay-download.js#resumeForOwner`).
- **Very large listings are capped, not paged.** Listings return at most `runtime-config.js#getListFilesCap()` entries; a share with more files doesn't render fully. Paging/virtualization is future work. Very large folders (hundreds of thousands of entries) also remain a memory-scaling risk for the single Bare worker.
- **Departed members can linger under some offline patterns.** Leave convergence (§6) relies on the leaver's own manifest plus witness observations; while the leaver *and every witness* are offline, a departed member stays in peers' rosters until that evidence replicates.
- **Frontend tests are local-only.** `test/frontend/` drives the real Electron app through the macOS accessibility tree, which headless CI can't do. §15.
- **Only production is actively seeded.** `mirall-seed.service` (prod) is the one active unit on the seed VM. `mirall-seed-staging.service` ships as a **disabled template** — there is no staging install base today. The dev channel has no seeder by design: dev builds are validated by direct download/install. → `seed-host/setup-guide.md`.
- **Asar is binary, not compressed.** True compression / bytecode obfuscation would need another layer (e.g. `bytenode` for the renderer); deferred until there's a concrete threat model. §13.
- **Custom `--storage` redirects userData.** `--storage <dir>` also calls `app.setPath('userData', dir)`, so `config.json` and the OTA applied-version marker share the custom dir. This enables clean multi-instance dev testing; dev data written by older builds may still sit split across two locations.

---

## 15. Testing & Accessibility

**The discipline — the change-type → required-coverage matrix, the a11y bar, red-first bug fixes, the CI gate composition — lives in `testing.md` and is authoritative there.** Also summarized for contributors in `CONTRIBUTING.md`; each `test/<layer>/` dir has its own `README.md`.

Structure only:

| Layer | Dir | Runner | Scope |
|---|---|---|---|
| **Unit** | `test/unit/` | `brittle-node` | Pure logic, no I/O: `path-keys`, validators, invite/ipc/share encoders, `echo-guard` TTL, ignore-matchers, runtime-config |
| **Integration** | `test/integration/` | `brittle-bare -j 4` (Bare) | Single-peer data layer against real `corestore`/`hyperdrive`/`hyperbee`, **no mocks**: owned-folder publish/reconcile, foreign-mirror materialize, mount validation, share registry, transfers, cleanup-orphans, witness-prune |
| **Flow** | `test/flow/` | `brittle-node` orchestrating **real worker subprocesses** over a hermetic `hyperdht` testnet | End-to-end P2P: membership convergence, transfers, owned-folder replication, foreign-mirror, move/copy/delete, leave/reconcile, offline behaviour, multi-peer (3–4) |
| **Raw (holepunch)** | `test/raw/` | `brittle-node` | Primitive guarantees of the deps themselves (Hyperdrive replication/deletes/blob streaming, Hyperbee mutations, Corestore namespacing) — **no Mirall code**. A trust-but-verify layer |
| **Frontend (UI)** | `test/frontend/scenarios/` | `node test/frontend/run.mjs` driving the **real Electron app** via `agent-desktop` (macOS AX tree) | User-facing flows incl. owner-side filesystem operations — **the only layer exercising the real chokidar → publish → replicate → materialize path.** Local-only |
| **Layout** | `test/frontend-layout/` | `node test/frontend-layout/run.mjs` (real Chromium) | Pixel-layout assertions on real components inside the real app-shell wrappers — complements the AX-tree suite, which can't read layout. Local-only |

`test/helpers/` is the shared harness: `peer.js` (`launchPeer`, `connectInSpace`, `addPeerToSpace`, `waitForCatalogEntry`), `store.js` (`freshPeer` — single in-process peer), `owned.js` (`setupOwnedShare`, `setupSelfMirror`), `fixtures.js`, `testnet.js` (`localTestnet` — 3-node DHT bootstrap), `fake-ipc.js`.

Local scripts: `npm test` = `test:node` (`test:node:core` = unit + raw, then `test:flow`) + `test:bare` (integration). `npm run lint` = `eslint src`; `lint:ci` adds the comment-hygiene gate (`scripts/check-comment-hygiene.sh --strict` — comments must be purpose-driven and self-contained; `.claude/solution-architecture.md` is the one permitted pointer target).

CI composition and the a11y bar → `testing.md`.

---

## 16. Identity & Security Model

### Master secret (M) & key derivation

A 32-byte **master secret (M)** roots all local key material: every writable core's keypair and every local encryption key derives from it (`core/store.js`, `identity-keys.js`). M is stored only in `identity.enc` beside the store, wrapped by a **KEK** from a pluggable unlock provider — by default the OS keychain via Electron's `safeStorage` (`main/identity-kek.js`, `core/unlock-providers.js`, `identity-envelope.js`, `identity-resolve.js`).

The wrap flow guarantees **the RocksDB seed never doubles as the identity**: a fresh install generates an independent random M, while a store predating the envelope preserves its seed as M, then replaces the persisted seed and best-effort-drops the superseded seed blocks.

### Encryption at rest

Local-only metadata bees (`LOCAL_BEE_NAMES`: spaces-meta, downloads-meta, pending-transfers, reclaim-meta, mounts-meta, app-migrations) are encrypted with an M-derived key. Stores peers must read are not encrypted at that layer: the **profile bee replicates in plaintext**; share catalogs are encrypted with the space's SCK instead, so only members can read them (§3.7).

### Space content key (SCK)

A per-space symmetric key encrypting the space's catalogs — **possession is read access**, which makes membership approval a cryptographic gate rather than a UI state. The creator derives a space's SCK deterministically from M (nothing to store); joiners receive it at approval, sealed to their bound signer key (`transfer/sck-seal.js`), and keep it in the space-keys vault (`space-keys.enc`, wrapped by an M-derived key).

### Handshake identity binding

Every identity-asserting frame on `mirall/handshake` (handshake, membership request/grant, leave) carries a signature binding the sender's profile key to the socket's Noise key — and, on handshakes, to its per-space drive key — verified in `transfer/handshake-guard.js`. Frames are therefore attributable: a connected peer cannot impersonate another member, kick a third party out of member lists, or claim a foreign drive as its own.

### Membership

Joining is request → approval. A **membership grant** hands over the sealed SCK and asserts the space's member-set root, authenticated by the granter's identity binding (**a plaintext SCK is refused as a downgrade**). Member rosters fold as an **OR-Set** (adds/removes with tombstones) so concurrent joins and leaves converge. The set's root of trust is pinned to the space creator and adopted only from authenticated assertions — a TOFU-pinned root (e.g. from a bearer invite hint) stays *provisional* until confirmed.

### Serve authorization

File bytes are served only when three gates pass (`transfer/backends/overlay/overlay-authorize.js`):

1. the requester's claimed profile key is Noise-authenticated on the requesting socket,
2. a per-requester rate limit admits the request,
3. the requester is an approved member of a space advertising that content hash.

**A denial is observationally identical to "I don't hold this file"**, so membership cannot be probed.

Locally the reasons are kept apart: only `UNAUTHENTICATED` and `NOT_A_MEMBER` are refusals, and only those reach the audit log as `security.serve_denied` (the Activity Log row names the reason). `NO_SOCKET` (teardown race), `RATE_LIMITED` (flow control) and `NOT_HELD` (gate 3 found no space advertising the hash) are ordinary operation and record nothing — a multi-source fetch broadcasts its content-request to every connected peer instead of asking holders first, so being asked for content this device does not advertise is the normal case, not an incident.

### Resource bounds

`core/runtime-config.js` centralizes DoS/resource budgets: caps on peer-supplied data (e.g. avatar data-URI length), read timeouts bounding how long an offline peer can stall aggregation, the identity-frame limiter (matched burst scaled by the topics a socket has proven it shares) and the serve-gate rate limiter. A budget that is multiplied by a live count is clamped finite and non-negative where it is read, so a hand-edited `Infinity` cannot silently disable the lane it is meant to bound.

---

## 17. Glossary

**Stack terms** ([Holepunch](https://docs.pears.com) building blocks):

- **Bare** — the minimal JavaScript runtime the worker runs on (not Node; `bare-fs`, `bare-path`, … are its stdlib).
- **Hypercore** — signed append-only log, the primitive under everything; a "core".
- **Hyperbee** — key/value database on a Hypercore; a "bee".
- **Hyperdrive** — filesystem abstraction on Hypercores; a "drive".
- **Corestore** — manages all cores in one storage directory (RocksDB-backed).
- **Hyperswarm** — DHT peer discovery + encrypted socket connections.
- **Noise** — the encrypted transport under every peer socket; a socket's *Noise key* identifies its endpoint.
- **Protomux** — multiplexes several protocol channels over one socket.

**Mirall terms:**

- **Space** — a shared topic peers join; the unit of membership, discovery, and sharing.
- **Loose file** — a file shared individually into a space; peers download it explicitly (never auto-synced).
- **Share / owned folder** — a local directory tree published into a space by its owner.
- **Foreign folder / mirror** — another member's share materialized read-only to a local folder.
- **Mount** — the association between a share and a local disk path, on either side.
- **Catalog** — the replicated, SCK-encrypted listing of a share's files (path, size, mtime, content hash).
- **Overlay (backend)** — the content-addressed serve/fetch engine: bytes come from holders' real files on disk, addressed by content hash.
- **Content hash / chunk map** — a file's whole-file hash and its per-chunk hash list; both computed at publish, verified at fetch.
- **M (master secret)** — the 32-byte root secret all writable-core keys and local encryption keys derive from; stored wrapped in `identity.enc`.
- **KEK** — key-encryption key wrapping M; from a pluggable unlock provider (OS keychain by default).
- **SCK (space content key)** — per-space key encrypting catalogs; possession = read access; handed to joiners at approval.
- **Identity binding** — the signature tying a peer's profile key to its socket's Noise key (and per-space drive key); what makes frames attributable.
- **Membership grant** — the approval message carrying the sealed SCK and the authenticated member-set root.
- **OR-Set** — conflict-free add/remove set used to fold member records from multiple writers.
- **LWW** — last-writer-wins: newest timestamp takes the value (for single-value records).
- **TOFU** — trust on first use: accepting a key provisionally until an authenticated assertion confirms it.
- **Tombstone** — a record marked deleted (`deletedAt`) but kept, so replicas distinguish "removed" from "never seen".
- **Capability flag** — `caps/<feature>` marker in the profile bee; absence means "this peer doesn't publish that data", never "the data is gone".
- **Presence lease** — a short-lived, re-announced liveness claim; expiry means the peer is treated as offline.
- **Hint / `event:reconcile`** — the coalesced worker→renderer signal "state in this scope changed, refetch it".
- **Audit tier** — the confidence recorded with every audit row: A first-party, B a peer action authenticated on the socket, C derived from a peer's replicated bee (timestamp self-reported).
- **Partial** — an in-progress download file (`*.mirall.part`), atomically renamed on completion. The suffix is defined once in `src/shared/transfer/partial-suffix.js` and injected into the vendored overlay engine; it deliberately is not a bare `*.part`, which would collide with Firefox/KDE downloads in the same folder.
- **Pending transfer** — the persisted row describing an unfinished download; the source of resume and of paused/error UI states.
- **Channel** — a release line (`dev` / `staging` / `prod`), each an independently-keyed update drive.
