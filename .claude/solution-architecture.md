# Mirall — Solution Architecture

## 1. Overview

Mirall is a peer-to-peer file-sharing desktop application built on the **pear-electron-runtime** architecture: an Electron host process that embeds [`pear-runtime`](https://github.com/holepunchto/pear-runtime) as a library, plus a Bare worker for the P2P data layer. Users create a profile, organize into "spaces" (collaborative topics), and share files directly between peers — no servers, no cloud infrastructure.

Mirall has **two sharing modes** inside a space:

1. **Loose files** — the original model. Files are never synced automatically: users see a catalog of all available files across a space (metadata replicates via Hyperdrive) and explicitly choose which files to download. The UI reflects a **canonical nine-state file model** — every file is in exactly one state at any time (see §3.5).
2. **Shared folders ("owned folders")** — a whole local directory tree published as a *share*. The owner mounts a disk folder; a filesystem watcher (`chokidar`, in the Electron main process) keeps the share's Hyperdrive prefix in sync with disk. Any peer can **mirror** that share to a local folder of their choosing (a *foreign mount*), and the worker continuously materializes the owner's files to that disk path. Unlike loose files, shared folders *do* sync continuously — but only after the owner opts in (mount) and the peer opts in (mirror). See §7 "Folder Sharing." Loose files and shares coexist in the same space; `listFiles` filters share-prefixed paths out of the loose-file catalog so each file appears in exactly one place.

§16 documents the identity & security model (key hierarchy, encryption at rest, membership gating, serve authorization); §17 is a glossary of the domain terms used throughout the source.

### How the app ships

- **Local development** — `npm start` (Electron + worker, OTA disabled by default). `npm start -- --updates` to test the OTA flow. Hot-reload dev with `npm run dev` (esbuild + Tailwind in watch mode + a local HTTP server for `assets/`).
- **Distributable installers** — `.dmg` (macOS), `.msix` (Windows), `.AppImage` (Linux), built by `electron-forge` (CI: `.github/workflows/build-electron.yml`). DMG/MSIX use forge makers; AppImage is assembled by `scripts/build-app-image.sh` from forge's packaged output.
- **Over-the-air updates** — once installed, the running app subscribes to a Pear Hyperdrive (the "channel drive"). When a new release is staged on the seed host and the drive head advances, the local app mirrors the new bundle and atomically swaps it in (`fsx.swap` for `.app`/`.AppImage`, `msix-manager.addPackage` for Windows).
- **Seed host** — Arch Linux VM running `mirall-seed.service` (a systemd unit that runs `pear seed production` continuously). Operators run `seed-host/scripts/release.sh` from a dev machine to push new builds to the channel drive.

### Three release lines (channels)

Each is its own Pear Hyperdrive with its own `pear://` upgrade key, stored in `.github/workflows/build-electron.yml` secrets and the seed host's `~/.config/mirall/upgrade-keys.json`:

| Channel | Trigger | Audience | Snapshot? |
|---------|---------|----------|-----------|
| `dev` | every push (or workflow_dispatch) | internal devs | no |
| `staging` | `release/*` branches | wider stakeholders | no |
| `prod` | `v*` tag push (or workflow_dispatch with channel=prod) | end users | yes (Hetzner VM snapshot via `release.sh`) |

A bundled CI version is patched into the DMG/MSIX/AppImage's `package.json` before signing — `<base>-<channel>.${GITHUB_RUN_NUMBER}` for non-prod, or the tag version for prod. The drive's root `/package.json#version` is set to that same string by `seed-host/scripts/build-stage-artifact.sh`. Drive version === bundle version is what makes the OTA banner fire only when there's actually a newer release.

### Core technologies

| Component | Purpose |
|-----------|---------|
| **Electron** | Host process. Owns the main process, the BrowserWindow (Chromium renderer), and the IPC bridge to the worker. |
| **pear-runtime** | Embedded as a library (`require('pear-runtime')`). Provides the OTA updater, drive replication, and `pear.run(entrypoint)` for spawning Bare workers. |
| **pear-runtime-updater** | Watches the channel Hyperdrive, mirrors new bundles, and applies them via `fsx.swap` (mac/linux) or `msix-manager.addPackage` (windows). |
| **Corestore** | Manages all Hypercores in a single persistent store. Constructed in main and passed into both `PearRuntime` and (via the worker bootstrap) the worker's data layer. |
| **Hyperbee** | Key-value store on Hypercore (profile, spaces, downloads, pending transfers). |
| **Hyperdrive** | P2P filesystem for file sharing (one writable drive per user per space) plus the upgrade drive watched by `pear-runtime-updater`. |
| **Hyperswarm** | Peer discovery + encrypted NOISE sockets. |
| **Protomux** | Protocol multiplexing (Corestore replication + `mirall/handshake` on one socket). |
| **compact-encoding** | Wire encoding for the handshake channel. |
| **hypercore-storage** | Low-level RocksDB keys used by `purgeCoreDk()` to delete cores cleanly. |
| **b4a** | Cross-platform Buffer utilities (Bare-compatible). |
| **bare-fs / bare-path / bare-os / bare-subprocess / bare-https** | Bare-runtime stdlib used by the worker. |
| **chokidar** | Filesystem watcher for owned-folder shares. Runs in the **Electron main** process (Bare has no native recursive-watch), forwarding `add`/`change`/`unlink` events to the worker over IPC. |
| **TypeScript** | Renderer source language (compiled to JS via `tsc` + bundled by esbuild). |
| **React 19** | UI framework (renderer process). |
| **React Aria** | Accessible UI primitives. |
| **Tailwind CSS v4** | Utility-first styling framework. |
| **modern-screenshot** | Renders a screenshot of the app into the feedback payload. |

---

## 2. Process Architecture

Mirall runs across **three processes**: the Electron main process, the Electron renderer (Chromium running React), and a Bare worker spawned via `pear-runtime`. The main process owns lifecycle, the BrowserWindow, and all access to `pear.updater` / OS APIs. The renderer is sandboxed and reaches main only through a contextBridge. The worker is a Bare child process that runs all P2P / file-system / network logic; it talks to the renderer through main, which forwards IPC frames in both directions.

```
┌────────────────────────────────┐  contextBridge   ┌────────────────────────────────┐
│   ELECTRON MAIN                │ ◄──────────────► │   ELECTRON RENDERER            │
│   src/main/main.js             │  (window.bridge) │   src/renderer → assets/dist   │
│                                │                  │                                │
│  PearRuntime (library)         │                  │  React 19 + Tailwind           │
│  ├─ updater (channel drive)    │                  │  ├─ Onboarding / Shared Spaces │
│  ├─ run(workerPath) → Bare     │                  │  ├─ Space View / Folder View   │
│  └─ external Corestore + swarm │                  │  ├─ Settings family / Storage  │
│                                │                  │  └─ About / Feedback           │
│  IPC handlers (pear:*, …)      │                  │                                │
│  notifications.js              │                  │  src/renderer/ipc.ts           │
│  owned-folder-watchers.js      │                  │  └─ window.bridge.*            │
│   └─ chokidar → fs-event       │                  │                                │
└────────────────────────────────┘                  └────────────────────────────────┘
            │           ▲                                        ▲
            │ NDJSON    │ event:owned-folder-fs-event            │ pear:worker:ipc / stdout / exit
            ▼           │                                        │
┌────────────────────────────────────────────────┐             │
│   BARE WORKER  src/worker/main.js               │ ────────────┘
│                                                 │
│   src/shared/core/store.js → Corestore               │
│   ├── profile bee (+ share/… records)           │
│   ├── spaces-meta / downloads-meta              │
│   ├── pending-transfers / mounts-meta           │
│   └── per-space drives (loose files + share/…)  │
│                                                 │
│   swarm.js      → Hyperswarm + Protomux         │
│   backends/overlay → content backend (serve/fetch)│
│   files.js      → loose-file listing + reveal    │
│   shares.js / share-registry / share-catalog     │
│   owned-folders.js   → publish (fs-event → put) │
│   foreign-folders.js → mirror materialize loop  │
│   mount-store / mount-validate / path-keys      │
│   storage.js / feedback.js                      │
└────────────────────────────────────────────────┘
                        │
                        ▼
                   ┌────────┐
                   │ PEERS  │  Corestore replication +
                   │        │  mirall/handshake channel
                   └────────┘
```

### Main process (`src/main/main.js`)

Roughly the following responsibilities:

1. **Argument parsing** via `paparam` — `--storage <dir>` (custom data dir, also redirects Electron's `userData`), `--no-updates`, `--menu` (force-show menu on Win/Linux for DevTools access), `--no-sandbox` (declared so paparam doesn't bail when AppRun forwards it on Linux).
2. **`PearRuntime` construction** with externally-built `Corestore` + `Hyperswarm` so we control replication and topic-join behaviour. The `version` passed to PearRuntime is whatever's in the bundled `package.json`; CI patches that file at build time so the version is `<base>-<channel>.<run_number>` for non-prod or the tag for prod.
3. **Updater wiring** — when `updates !== false`, joins the upgrade drive's discovery key as a hyperswarm client, replicates incoming connections into the Corestore, listens for `pear.updater.on('updating'/'updated')`, and forwards events to the renderer as `pear:event:*` IPC messages.
4. **Worker spawn** via `pear.run(entrypoint, [])`. `getWorker(specifier)` is idempotent (cached in `workers: Map<specifier, worker>`), bootstraps the worker with a JSON line containing `{ storage, appVersion, dev, fork, length, verbose }`, and bridges three IPC channels:
   - `pear:worker:writeIPC:<spec>` → renderer-to-worker (NDJSON written to worker stdin). Try/catched to swallow shutdown-race EPIPE/FIN.
   - `pear:worker:ipc:<spec>` → worker-to-renderer (NDJSON read from `worker.on('data')`).
   - `pear:worker:stdout/stderr/exit:<spec>` → console + lifecycle events.
5. **BrowserWindow** with `preload: src/preload/preload.js`, `sandbox: true`, `contextIsolation: true`. All app configuration (window bounds + zoom, theme, general prefs, download folder, on-demand cache budget, and renderer-only UI prefs) lives in a single `getDataDir()/config.json`, owned exclusively by main via `ConfigStore` (`src/main/config-store.js`): atomic writes (tmp→fsync→rename), merge-over-defaults on read, a `version` migration seam, and a one-time fold of the pre-unification per-setting files (`zoom/window-bounds/theme/app-prefs/download-settings.json` and the worker's `ondemand-cache.json`) plus the renderer's `localStorage` keys into it (originals deleted after the unified file is durably written). Window bounds are read on launch and written debounced on resize/move.
6. **DevTools shortcut** — `webContents.before-input-event` toggles DevTools on F12 / Ctrl-Shift-I (Win/Linux) or Cmd-Opt-I (mac). Necessary because the menu is hidden on Win/Linux by default.
7. **Update apply flow** — updates apply without user action. On Windows/Linux, main pre-stages the swap in the background as soon as the updater reports `updated`; macOS defers to quit (a mid-session `fsx.swap` would let later disk re-reads mix new-version files with old in-memory code). A `before-quit` hook promotes any staged-but-unapplied bundle — `event.preventDefault()` → `await applyUpdate()` → re-`quit()`, because Electron does not await async listeners and the swap must finish before exit. `pear:applyUpdate` remains as a manual IPC trigger. See §9.
8. **Diagnostic IPC** — `pear:checkForUpdate` triggers `pear.updater._debouncedUpdate()` and reports `{length, fork}`. `pear:appVersion` reads the live drive head's `package.json#version` for display in the update banner. Both used by the renderer's update flow.
9. **Native notifications & shell** (`src/main/notifications.js`) — `notify:show` constructs an Electron `Notification` (per-platform fallback icon: `resources/{darwin/icon.icns,win32/icon.ico,linux/icon.png}`), `notify:isWindowFocused` lets the renderer suppress notifications when the window is focused, `notify:focus` raises the window from a notification click, and `shell:showInFolder` reveals a path (gated to `os.homedir()` to keep the renderer from poking arbitrary disk locations).
10. **Asar spawn shim** — when the bundle is asar-packed (see §13), `child_process.spawn` is monkey-patched to rewrite `app.asar/` → `app.asar.unpacked/` in the executable path and argv. Without it, `bare-sidecar`'s `spawn(bareBinary, [workerEntry, …])` ENOTDIRs because `require.resolve()` returns asar paths and the OS can't walk into the archive. No-op outside packaged builds.
11. **Custom protocol handler** — `app.setAsDefaultProtocolClient('mirall')` registers the `mirall://` scheme on macOS/Windows. `app.requestSingleInstanceLock()` ensures repeated launches focus the running instance. Three trigger paths funnel into `dispatchDeepLink()`: macOS `open-url`, Win/Linux `second-instance` (warm), and a direct argv scan at boot for cold-start URLs (positional, so paparam can't help). `parseDeepLink` (`src/main/deeplink.js`) validates and returns `{kind:'join', code, name?}`; main forwards on the `deeplink` IPC channel, queueing in `pendingDeepLinks[]` until the renderer calls `deeplink:flush`. Linux AppImage installs additionally rewrite `~/.local/share/applications/Mirall.desktop` at launch (`integrateXdgLinux`) to declare `MimeType=x-scheme-handler/mirall;` and an absolute `Exec=` so xdg-mime can route URLs to the (possibly moved) AppImage. See §5.2 for the renderer side.

12. **Owned-folder filesystem watchers** (`src/main/owned-folder-watchers.js`) — `chokidar` lives in Electron main, never in the worker, because Bare has no native recursive-watch. (A second main-process chokidar host, `src/main/loose-file-watchers.js`, watches individual absolute paths for in-place loose-file shares, fanning each `add`/`change`/`unlink` out to every space watching that path.) The worker asks main to `owned-folder:start-watcher` / `owned-folder:stop-watcher` (IPC, also exposed to the renderer via `bridge.startOwnedFolderWatcher`). `startWatcher(shareId, mountPath, ignore, …)` opens a chokidar watch with `ignoreInitial: true`, `awaitWriteFinish` (debounced), `followSymlinks: false`, and switches to polling for network-looking paths (`/Volumes/`, `/mnt/`, SMB/NFS). Each `add`/`change`/`unlink` is forwarded to the worker as an `event:owned-folder-fs-event` frame `{ shareId, action, relPath, absPath }`. An error-burst guard stops a watcher that throws ≥5 times in 10 s. `stopAllWatchers()` runs on `before-quit`.

The main process otherwise holds **no** application state (no profile, no spaces, no transfers). It's a thin bridge between OS / pear-runtime / OTA mechanics / the filesystem watcher on one side and the renderer/worker on the other.

### Renderer (`src/`, bundled to `assets/dist/`)

React 19 application. Compiled by `tsc --noEmit` (typechecking only) + esbuild (bundling). Loaded into the BrowserWindow via `assets/index.html` referencing `assets/dist/main.js` and `assets/dist/app.css`.

`src/renderer/ipc.ts` wraps the worker IPC bridge into a request/response API:

```ts
// renderer side
import { request, subscribe } from './ipc.js'

await request('files:list', { spaceId })   // Promise<FileEntry[]>
const off = subscribe('event:files-updated', ({ spaceId }) => …)
```

Internally:
1. The renderer calls `window.bridge.startWorker('/src/worker/main.js')` once on mount.
2. Outgoing requests serialise to NDJSON, get an `id`, and are sent via `window.bridge.writeWorkerIPC('/src/worker/main.js', frame)`.
3. Incoming frames arrive via `window.bridge.onWorkerIPC('/src/worker/main.js', listener)`, are parsed, and dispatched to either pending request resolvers (matched by `id`) or event subscribers.

`src/renderer/updates.ts` (singleton) subscribes to `window.bridge.onPearEvent('updated')` and exposes the staged-update state to React (`UpdateBanner` + `useUpdates`). On `updated` it reads the staged version via `window.bridge.appVersion()` (in dev builds it simply reloads the window instead). The banner is passive — the update applies in the background or on quit (§9); its Dismiss button only hides the banner, while the About screen keeps showing the staged-update notice.

### Worker (`src/worker/main.js`)

Bare process spawned by `pear.run('/src/worker/main.js')`. ESM (`src/worker/package.json` has `"type": "module"`). Imports the `src/shared/*` modules and registers IPC handlers with `src/shared/core/ipc.js`'s NDJSON router.

Bootstrap sequence:
1. `createIPC(Bare.IPC)` — buffered NDJSON router on the stdio pipe Bare establishes with the parent.
2. `getBootstrapPromise()` blocks for the first `{type: 'bootstrap'}` line containing `{ storage, appVersion, dev, fork, length, verbose }`.
3. `setRuntimeConfig(bootstrap)` and `createLogger('worklet')`.
4. `initStore` → `initSpaceKeys` → `initProfile` → `initSpaces` → `initDownloads` → `initPendingTransfers` → `loadDrives` (if any drives fail to load, `cleanupOrphanedData()` runs) → `ensureMembershipManifestCap` → `ensureSharesCap` (writes `caps/folder-shares`) → `initMounts` (opens the `mounts-meta` bee).
5. `initOwnedFolders(ipc)` / `initForeignFolders(ipc)`, then `initBackends(ipc)` (the overlay instance) + `initLooseOverlay(ipc)`, and finally `initSwarm(ipc)` — every connection hook attaches before the swarm accepts sockets. `initForeignFolders` also installs `setOverlayCatalogChangeHook(onPeerDriveChanged)` so a peer-catalog append nudges the relevant mirror loops promptly.
6. Join every existing space's Hyperswarm topic.
7. **Resume folder shares from persisted mounts.** For each owned mount: if its `mountPath` is gone, emit `event:owned-folder-mount-status: 'mount-point-gone'`; else ask main to start a chokidar watcher, run a catch-up `periodicReconcile`, and schedule the recurring reconcile timer. For each enabled foreign mount: `startForeignLoop(mount)` + an `initialMaterializeScan`.
8. Start the **mount-probe loop** (every 60 s) — re-checks every mount's disk path so USB unmounts / network-path drops flip the share to `mount-point-gone` and a re-appearance restarts the watcher/loop.
9. Register every IPC handler, then `ipc.start()` flushes any queued requests that arrived before handlers were registered.
10. Emit initial state: `event:state` (profile + spaces) or `event:profile-needed` if onboarding hasn't happened, then `event:worker-ready`.

Shutdown is driven by `Bare.IPC.on('end'|'close'|'error')` — calls `safeShutdown()`, which tears down the backends and swarm (under a hard deadline) and `Bare.exit(0)`. In-flight downloads need no suspend step: the durable pending rows (§3.4) reconstruct resume state on the next run. This fires when the renderer's BrowserWindow closes or when the parent Electron main process exits.

---

## 3. Data Model

All persistent state flows through a single **Corestore** at `Pear.config.storage` (resolved from the worker bootstrap's `storage` field, which is the main process's `getDataDir()`). `src/shared/core/store.js` exposes `initStore()`, `getStore()`, `createBee(name)`, and `createDrive(name)`.

### 3.1 Profile Hyperbee

| Field | Core name | Encoding |
|-------|-----------|----------|
| Profile | `profile` | utf-8 keys, JSON values |

| Key | Value | Notes |
|-----|-------|-------|
| `displayName` | `"Alice"` | Required |
| `avatar` | `"data:image/jpeg;base64,..."` | Optional; resized to 160×160 JPEG on the client (`src/renderer/utils.ts::resizeAvatar`) |
| `publicKey` | `"ab3f..."` | Hex of the profile core's public key (also the peer identity) |
| `caps/<name>` | `true` | Capability flags — see "Capability Flag Convention" below |
| `member/<spaceId>` | `{ active: true, ts: <ms> }` | Per-space membership manifest. Existence ⇒ active member; absence ⇒ left. Read by remote peers during reconciliation (`readPeerMembership` in `src/shared/spaces/profile.js`). Gated by `caps/membership-manifest` |
| `observed/<peerKey>/<spaceId>` | `{ ts: <ms> }` | Witness observation — written when this peer observes another peer leave a shared space (via `handleLeaveFrame` or in the prune branch of `reconcileMember`). Reconciliation reads these from every connected peer's bee as a backup evidence source for offline-at-leave receivers. Gated by `caps/leave-observations` |
| `share/<spaceId>/<shareId>` | `{ id, type:'owned-folder', name, owner, createdAt, deletedAt? }` | A **folder share** the local user owns in this space. Replicates to peers via the profile bee — that's how peers discover what folders are on offer. Deletion is a **tombstone** (`deletedAt` set, row kept) so peers can distinguish "owner removed this share" from "never replicated." Gated by `caps/folder-shares`. See §7 |

The profile bee's **core key is the user's peer identity**. Peers fetch each other's avatars and read each other's manifests by opening the remote profile bee by that key (`openProfileBee()`), with a 10-second timeout for the avatar path and a 1.5 s timeout for the membership read.

#### Capability Flag Convention

Peer-to-peer features that need to distinguish "this peer doesn't publish data X" from "this peer left / disabled X" must use a named capability flag in the profile bee, **not** the application version. Pattern:

| Aspect | Rule |
|---|---|
| Key shape | `caps/<feature-name>` |
| Value | `true` (boolean) |
| Read semantics | Absence ⇒ peer doesn't publish this feature ⇒ treat related data absences as **unknown**, not negative |
| Write order | Capability flag is written **before** the feature's data keys (see `markOwnMembership` writing `caps/membership-manifest` via `ensureMembershipManifestCap` ahead of the `member/<spaceId>` put) |
| Removal | Drop the flag — never reuse it for an incompatible meaning. Add a new flag instead |

**Why named flags, not a monotonic version number:** independent features (membership manifest, future presence heartbeat, future ACLs) ship at different cadences. A single `manifest/version` ties them together; a fork can support one without the other; removing a feature from a single version field is awkward. Named flags decouple all of this and self-document at the storage layer. The pattern matches HTTP `Upgrade`, IRCv3 `CAP`, OAuth scopes — capability negotiation, not version comparison.

**When to use vs. skip:** use whenever a remote peer's *absence of data* would otherwise be ambiguous between "left/disabled" and "old client / never participated." For data that's strictly additive (e.g. avatar — absence is unambiguously "no avatar set"), no flag is needed.

Currently defined:
- `caps/membership-manifest` — gates `member/<spaceId>` reads
- `caps/leave-observations` — gates `observed/<peerKey>/<spaceId>` reads
- `caps/folder-shares` — gates `share/<spaceId>/<shareId>` reads (folder sharing — §7). Written by `ensureSharesCap()` before the first share is published

### 3.2 Spaces Hyperbee

| Field | Core name | Encoding |
|-------|-----------|----------|
| Spaces metadata | `spaces-meta` | utf-8 keys, JSON values |

Never replicated — purely local bookkeeping.

| Key | Value |
|-----|-------|
| `space/<id>` | `{ name, icon, topic, created, members, favorite? }` |

Where:
- `id` — first 16 hex chars of the topic.
- `icon` — Material Symbols name (`folder_shared`, `movie`, …).
- `topic` — 32-byte Hyperswarm discovery topic (hex).
- `members` — `[{ publicKey, driveKey, displayName, avatar? }]`.
- `favorite` — optional boolean set by the favourite toggle.

The local user's own drive key is **not stored** here directly — it's derived from `store.namespace('space-drive-' + spaceId + '-' + driveSuffix)`. The `driveSuffix` (random 8-byte hex) is generated on `createSpace`/`joinSpace` and persisted on the space record; `loadDrives` re-opens the same namespace on subsequent starts. The suffix is stable across restarts of an active membership but **changes on rejoin after leave** — `purgeSpace` deletes the record, so the next `joinSpace` for the same `spaceId` generates a fresh suffix → fresh keypair → fresh `driveKey`. Other peers see the rejoiner as a new drive identity with empty contents, sidestepping the "stale blocks resurrect on deterministic-key reuse" problem (older records without `driveSuffix` fall back to the unsuffixed name used by earlier releases, so existing installs keep working).

### 3.3 Downloads Hyperbee

| Field | Core name | Encoding |
|-------|-----------|----------|
| Download history | `downloads-meta` | utf-8 keys, JSON values |

| Key | Value |
|-----|-------|
| `<spaceId>:<filePath>` | `{ downloadedAt: <ms> }` |

Survives restarts. Cleared per-space on leave (`cleanupDownloadHistory`). A file counts as `downloaded` (local) iff this bee has an entry for it.

### 3.4 Pending-Transfers Hyperbee

| Field | Core name | Encoding |
|-------|-----------|----------|
| Pending downloads | `pending-transfers` | utf-8 keys, JSON values |

| Key | Value |
|-----|-------|
| `<spaceId>:<filePath>` | `{ total, inPlace, ownerKey, finalPath, shareId, relPath, bytesTransferred, updatedAt, errorCode?, erroredAt? }` |

`finalPath` is the real landing path in the download folder (collision-avoided, see §3.5); the in-progress `<finalPath>.overlay-partial` and the resume journal are derived from it. A pending row represents an in-flight or interrupted download; the engine's progress ticker persists `bytesTransferred` here so we can:
- Derive the UI status (`paused-interrupted`, `paused-offline`, `error`) without needing the active transfer.
- Auto-resume when the owner reconnects or its catalog changes (see §4.5).
- Show partial-byte progress after restart.

Rows are cleared on completion (`clearPending`), on cancel, on `files:discard-partial`, and on space leave.

### 3.5 Per-Space Hyperdrive

- Created via `store.namespace('space-drive-' + spaceId + '-' + driveSuffix)` → `new Hyperdrive(namespacedStore)`. The suffix is per-membership (re-rolled on rejoin after leave); see §3.2 for the rationale.
- **Identity only — the drive carries no file bytes.** Its `driveKey` is the member's per-space identity: the handshake binding signs `noise||driveKey` (§16) and members are matched by it. `listFiles` reads the local drive solely for that key; `files:add` only checks that it exists.
- **No peer drives are opened.** Peers' loose/folder metadata is read from their replicated, SCK-encrypted catalogs (§3.7), opened lazily per catalog key and cached (`peerCatalogs` in `share-catalog.js`) with bounded read timeouts so one offline peer can't stall a listing. File bytes travel only through the overlay backend (§7.8), addressed by content hash.

### Canonical File-State Model

`src/shared/transfer/files.js` derives every loose file's status from five signals: the own/peer catalog entries, the Downloads bee (re-verified against the disk on every list — the file on disk is the truth, stale claims are pruned), the Pending-Transfers row, live presence (`isOwnerOnline`), and live engine state (is a fetch running right now).

| Status | Meaning | Signals |
|--------|---------|---------|
| `mine` | Local file I shared (in place) | Own catalog entry with a content hash |
| `publishing` | Own file still being hashed | Own catalog entry without a hash + active publish |
| `preparing` | Peer's file still being hashed by its owner | Peer catalog entry without a content hash |
| `downloaded` | Peer file, fully on disk | Downloads-bee claim, verified against disk |
| `downloading` | Active fetch in progress | Live engine state |
| `paused-interrupted` | Fetch interrupted, owner online | Pending row (no `errorCode`) + owner online |
| `paused-offline` | Paused because the owner went away | Pending row + owner offline |
| `remote` | Peer file, owner online, no local data | Peer catalog entry, no pending row |
| `unavailable` | Peer file, owner offline, no local data | Peer catalog entry + owner offline |
| `error` | Fetch failed | Pending row with `errorCode` |

Duplicates collapse per **content hash** (`dedupeByHash`): the most-progressed candidate wins by `STATUS_PRIORITY` (`mine` beats `downloaded` beats `downloading` beats `paused-*` …) and the rest fold into a `sharedByCount`.

### Sharing a File (In-Place Publish)

Nothing is copied when a file is shared, and nothing is chunked over IPC. The renderer resolves a dropped browser `File` to its real filesystem path via `webUtils.getPathForFile(file)` (exposed through `window.bridge.getPathForFile`) and hands the path to the worker (`files:add`, timeout `0`); `loose-overlay.js` registers the file **in place**:

1. **Vet the source** (`assertSharableSource`) — must be a real, non-empty file on disk; macOS promised-file temp paths are refused so a share never points at a path that vanishes.
2. **Resolve the name** against the space's loose catalog (collision → free-name suffix; at most `MAX_LOOSE_FILES_PER_SPACE = 100` loose files per space).
3. **Advertise a placeholder** catalog entry (no content hash yet — peers render it as `preparing`), then stream the file **once**, computing the whole-file content hash and the chunk map in the same pass (`prepareForServe`, §7.8); finalize the catalog entry and make the hash servable.
4. **Record + watch the source path** — kept for reveal-in-file-manager, and watched (chokidar in Electron main) so edits/moves to the original are noticed.

Progress streams locally as `event:decoration { channel:'transfer', phase:'publishing', … }` and to peers as share-prepare frames (feature-gated) the receiver re-emits as `event:decoration { phase:'preparing' }`, so their `preparing` rows show live progress. `files:cancel-publish` aborts the hash mid-stream; a half-advertised entry is always reverted — the prior version is re-advertised, or a first-time publish is tombstoned. `files:remove` on an own file tombstones the catalog entry and drops the serve reference (evicting the chunk map when it was that hash's last reference); on a merely-downloaded peer file it only deletes the local download claim.

### Downloading a File (Overlay Engine + Pending-Transfers)

`files:download` routes to the shared **overlay download engine** (`src/shared/transfer/backends/overlay/overlay-download.js` — the same engine serves non-mirrored folder-share reads; `src/shared/transfer/loose-overlay.js` supplies the loose glue). Observers (Finder/Explorer, Quick Look, backup tools, antivirus, the orphan sweep) only ever see either no file or a complete file — never a half-written one with the real name:

1. **Destination.** `resolveDest(downloadDir, basename)` (`download-dest.js`) picks a free final name: a name counts as taken if the plain file, `<name>.partial` (written by older releases), or `<name>.overlay-partial` exists — a download never overwrites the user's own file and never adopts another transfer's partial. A resumed download reuses the pending row's `finalPath`.
2. **Pending row first.** `recordPending` writes the §3.4 row before any bytes move; the engine is single-flight per file.
3. **Fetch by content hash** through the overlay (§7.8). Bytes land in `<finalPath>.overlay-partial`; chunks verify against the chunk map as they arrive; a **receive journal** (app-private `journals/` dir — received-chunk bitmap + a snapshot of the streaming hash) makes resume O(1); the engine renames partial → final atomically on completion.
4. **Progress is decoration, never status.** Ticks emit `event:decoration { channel: 'transfer', … }` and persist `bytesTransferred` to the pending row; the row's *status* is always re-derived by `files:list`, not pushed.
5. **Completion.** Pending row cleared, Downloads bee marked (`markDownloaded` plus the verified content hash), `event:transfer-complete` + `event:files-updated`.

**Pause / cancel / discard.** `files:pause-download` stops the fetch but keeps the partial, the journal, and the pending row (`event:transfer-paused`); a manual pause is remembered so reconnects don't resurrect it, and a fresh `files:download` resumes from the journal. `files:cancel-download` / `files:discard-partial` unlink the partial + journal and clear the row (`event:transfer-cancelled`).

**Failure semantics — no retry budget.** Recovery is level-triggered, not counted:

| Outcome | Effect |
|---|---|
| No holder / stall / owner quits mid-fetch | Not terminal: partial + row kept, `event:transfer-paused { reason: 'offline' }`; status derives `paused-offline` / `paused-interrupted` |
| Owner reconnects | The reconnect hook re-drives every pending row for that owner (skipping active, manually-paused, and checksum-failed rows) |
| Owner republishes (catalog append) | The per-owner catalog watch re-drives pending rows; an in-flight fetch of a superseded hash is cancelled and re-fetched (`event:transfer-superseded`) |
| Integrity failure (`EHASHMISMATCH`) | `TRANSFER_CHECKSUM`, terminal — never auto-resumed (the same holder would fail identically); only an explicit user retry re-attempts |
| Any other engine error | `DOWNLOAD_FAILED` recorded on the row → `error` status until the user retries |

**Boot sweeps.** `cleanupOrphanedOverlayPartials` removes `.overlay-partial` files (in the download dir and every foreign mount) that no pending row or resume journal references — a resumable partial is preserved; `cleanupOrphanedJournals` drops corrupt, stale (>7 days), or partner-less journals. Worker shutdown marks nothing: resume state is reconstructed from the durable pending rows on the next boot/reconnect.

### 3.6 Mounts Hyperbee

| Field | Core name | Encoding |
|-------|-----------|----------|
| Folder-mount bookkeeping | `mounts-meta` | utf-8 keys, JSON values |

Local-only (never replicated). Records which local disk paths back a folder share (`owned-folder-mount/…`) and which local paths mirror a peer's share (`foreign-folder-mount/…`). `src/shared/folders/mount-store.js` owns it. See §7 for the record shapes.

| Key | Value |
|-----|-------|
| `owned-folder-mount/<spaceId>/<shareId>` | `{ spaceId, shareId, mountPath, ignore[], createdAt, lastScanCompletedAt? }` |
| `foreign-folder-mount/<spaceId>/<shareId>` | `{ spaceId, shareId, ownerKey, mountPath, enabled, attachedAt, status?, initialScanCompletedAt? }` |

### 3.7 Share catalogs & encryption at rest

Alongside the bees above, each folder/loose share has a replicated **catalog** (`src/shared/shares/share-catalog.js`) that the overlay backend advertises into and consumers list from: the share's file metadata — path, size, mtime, content hash — keyed by the share's `catalogKey` and encrypted with the space's SCK (readable by members only). The local-only bees in this section are encrypted at rest with an M-derived key; the profile bee stays plaintext because peers must read it. See §16 for the key hierarchy.

### Why Per-User Drives (No Autobase)

Each user writes only to their own drive — no conflicts, inherent ownership, trivial aggregation at list time. Peer drives are read-only by design.

---

## 4. Networking

### 4.1 Hyperswarm Topology

Two `Hyperswarm` instances run side-by-side:
- **Main-process swarm** (`src/main/main.js`) — joins only the upgrade-drive discovery key as a client, used by `pear-runtime-updater` to replicate channel-drive updates.
- **Worker swarm** (`src/shared/transfer/swarm.js`) — joins one 32-byte topic per space, handles peer file-sharing connections.

Both share the same Corestore (passed from main into the worker via the bootstrap), so any incoming connection's `store.replicate(socket)` works against the unified store.

Topic join is non-blocking (`discovery.flushed()` runs in the background). `swarm.on('connection')` drops sockets immediately if the user is in zero spaces (prevents stray peers leaking into handshake code).

### 4.2 Protomux Handshake

Two channels share the same socket, both multiplexed via Protomux:

1. **Corestore replication** — `store.replicate(socket)` handles all Hypercore data sync (profile, spaces, drives).
2. **`mirall/handshake`** — a dedicated channel carrying JSON-encoded messages of two types:

```json
{ "type": "handshake", "profileKey": "<hex>", "driveKey": "<hex>",
  "displayName": "<string>", "spaceTopic": "<hex>" }

{ "type": "leave", "spaceId": "<id>", "profileKey": "<hex>" }
```

**Handshake** is sent one per local space per connection. `channel.onopen` iterates every joined topic and sends a handshake for each (`sendHandshakeMessages`).

**Leave frame** is broadcast by `space:leave` to every connected socket *before* the local teardown begins (see §6). Receivers (`handleLeaveFrame`) verify the claimed `profileKey` is one already authenticated on this socket via `socketToPeers` (spoof guard — without it, any connected peer could kick a third party out of others' member lists), prune the leaver from the persisted `members` array, evict from `connectedPeers`/`socketToPeers` for that space (so the eventual disconnect doesn't fire a duplicate `event:member-left`), and emit `event:member-left`.

On receipt (`handleHandshake`):
1. Match `spaceTopic` to a local `spaceId`. Ignore if we don't know this topic.
2. **Gate before admitting.** While we are ourselves still pending in the space (no SCK yet) the handshake stops here. For a v2 space, `admitV2Member` enforces the read gate: only a peer we (or a co-member) approved is admitted — anyone else is recorded as a converging join request and the handshake ends.
3. Upsert a `connectedPeers` entry keyed by `profileKey`. A peer can be connected on behalf of multiple spaces simultaneously — `peerEntry.spaces: Map<spaceId, driveKey>` tracks all of them. No peer drive or catalog is opened here — catalogs open lazily on first read (§3.5, §4.3).
4. Emit `event:member-joined` immediately (with any cached avatar from persisted members) so the UI unblocks without waiting on replication, and clear any stale join-request entry for the now-admitted peer.
5. Fire the overlay reconnect hook — pending downloads owned by this peer auto-resume (§4.5).
6. **Reciprocal handshake:** if the peer is new to this space, send back our handshake for the same space so the peer also learns about us — without this, two spaces-joined-late peers can end up invisible to each other.
7. Persist the peer as a space member if not already there, then emit `event:members-updated` — a handshake is also a presence arrival (§4.7).
8. Asynchronously fetch the peer's avatar from their profile bee (retried a few times — the avatar block may not have replicated yet on a fresh connection); a changed avatar updates the member record.

When a new space is joined while connections already exist, Hyperswarm reuses the existing sockets — no `'connection'` event fires. `joinSpaceTopic` therefore walks `socketMsgHandlers` and sends the new-space handshake to every already-connected peer.

### 4.3 Peer Catalog Caching

Peers' file metadata lives in their replicated catalogs, not in drives (§3.5). A peer catalog Hyperbee is opened lazily on first read (`openPeerCatalog` in `share-catalog.js`, keyed by catalog key, decrypted with the space's SCK) and cached in `peerCatalogs`; reads are bounded by an interactive timeout so an offline peer can't stall a listing. Catalog appends fire per-owner watches (`watchPeerCatalog`) that nudge foreign mirrors (§7.4) and re-drive pending downloads (§4.5).

### 4.4 Disconnect & Multi-Socket Handling

- `socketToPeers: Map<socket, Set<profileKey>>` — reverse index for disconnect.
- If a peer reconnects on a new socket, the old socket's `close` handler runs after the peer entry has been updated. The handler guards with `if (peer.socket !== socket) continue` so it doesn't delete a peer that has already reconnected.
- On genuine disconnect, `event:member-left` + `event:files-updated` are emitted for every space the peer was in, the presence lease is cleared instantly, and the `connectedPeers` entry is dropped. In-flight fetches from that peer notice the lost holder on their own and derive `paused-offline` (§4.5) — the pending rows stay.

### 4.5 Pause / Resume Transfers

Transfers respond to peer state automatically — recovery is level-triggered (reconnects and catalog changes re-drive the durable pending rows), with no retry counters:

| Event | Effect |
|---|---|
| Owner goes away mid-fetch | The fetch reports no holder → partial + pending row kept, `event:transfer-paused { reason: 'offline' }`; the row derives `paused-offline` |
| Owner reconnects | The overlay reconnect hook fires `resumeLooseForOwner` / `resumeOverlayForOwner`, re-driving every pending row for that owner (active, manually-paused, and checksum-failed rows are skipped) |
| Owner's catalog changes | The per-owner catalog watch re-drives pending rows; a fetch whose hash was superseded by a republish is cancelled and restarted (`event:transfer-superseded`) |
| Integrity failure | `TRANSFER_CHECKSUM` is terminal — only an explicit user retry re-attempts (§14) |
| Worker shutdown | Nothing is marked; the durable pending rows (§3.4) reconstruct resume state on the next boot/reconnect |

### 4.6 Startup Reconnection

On worker init: open Corestore → load profile → load spaces → init downloads bee → init pending-transfers bee → re-open all local drives (drop any whose open fails) → run orphan-core cleanup if any drive load failed → join all topics. Peers rediscover via the DHT; pending transfers resume as soon as the relevant peers reconnect.

### 4.7 Presence & liveness

Liveness is tracked separately from connection state: peers hold short-lived **presence leases** (heartbeat-refreshed, TTL-expired, cleared on disconnect — `src/shared/state/presence.js`). `connectedPeers` stays the routing registry ("where to send frames"); the lease answers "who is online". Durable state changes reach the renderer as level-triggered hints: the worker coalesces them into `event:reconcile { scope }` (`src/shared/state/hints.js`) and the UI refetches the affected scope, so a missed event can never leave the UI stale. Every list view rides this channel — files, shares, share-files, members, and join-requests scopes, fanned from the named `*-updated` pokes via `POKE_SCOPE` (`src/shared/core/ipc.js`); the named events stay on the wire as the emit-site API and as test/debugging observables.

---

## 5. Invitation Mechanism

1. Creator generates space → 32-byte random topic → formatted invite code.
2. Invite code displayed as dashed 8-char segments: `XXXXXXXX-XXXXXXXX-…` (`formatInviteCode`).
3. Joiner pastes the code (or clicks a deep link, see below); `decodeInvite` (in `src/shared/invite-envelope.js` / `src/renderer/invite-envelope.ts`) recovers the topic and any optional metadata.
4. Joiner's app creates a local drive (same namespace scheme), stores metadata, joins the Hyperswarm topic.
5. On the first connection, the protomux handshake exchanges drive keys; reciprocal handshake + Corestore replication do the rest.

### 5.1 Invite Envelope Formats

Two on-the-wire formats coexist. `decodeInvite` accepts either; `encodeInvite` always emits v1.

| Version | Shape | Payload | Use |
|---|---|---|---|
| **v0** (compat) | Bare 64-char lowercase hex | `topic` only | Emitted by older clients. Backward-compatible — older peers paste the dashed hex code. |
| **v1** | Base64url-encoded JSON `{v:1, t:<hex64>, n?:<name>}` | `topic` + optional space `name` (≤80 chars) | Default for new invites. Carries the space name so the joiner sees a real label instead of "Shared Space". |

`decodeInvite` strips dashes/whitespace, tries hex first (v0), then falls back to base64url-JSON (v1). Anything else returns `null`. `encodeInvite({topic, name})` is what the Invite dialog calls when generating the v1 string.

The renderer (`src/renderer/invite-envelope.ts`) and the worker/main (`src/shared/invite-envelope.js`) keep separate copies because they run in different module systems (TS+ESM vs JS+ESM, plus the Electron main needs CJS-friendly access via `src/main/deeplink.js`'s dynamic import). Behaviour is identical and tested at the boundary — diverging the two would silently break invites.

### 5.2 Deep-Link Delivery

URLs of the form `mirall://join/<code>` (or `mirall://join/?code=<code>`) launch or focus Mirall and pre-fill the Join Space dialog. `<code>` is either a v0 hex string or a v1 envelope; `parseDeepLink` (`src/main/deeplink.js`) validates protocol + host + code and returns `{kind:'join', code, name?}`.

OS hookup is per-platform:

| Platform | Hookup | Triggered by |
|---|---|---|
| **macOS** | `app.setAsDefaultProtocolClient('mirall')` registers the scheme via `LSSetDefaultHandlerForURLScheme`. Cold + warm dispatch both arrive via `app.on('open-url', …)`. | Click in browser, `open mirall://…`, Messages tap. |
| **Windows** | Same `setAsDefaultProtocolClient` writes the registry entry. Cold start: URL appears in `process.argv` and we scan for `mirall://` strings (skipping paparam, which would reject positional URLs). Warm start: `app.requestSingleInstanceLock()` + `app.on('second-instance', (_, args) => …)` — argv of the second invocation is forwarded to the running instance. | Click in browser, Run dialog, second `Mirall.exe mirall://…` invocation. |
| **Linux** | `.desktop` file declares `MimeType=x-scheme-handler/mirall;` and `Exec="…/Mirall" %U`. For AppImage installs, `integrateXdgLinux()` rewrites the user-local copy at `~/.local/share/applications/Mirall.desktop` on every launch (point 11 in §2). For deb installs, the maker's static `.desktop` template carries the same MimeType. Same single-instance + argv path as Windows. | xdg-open, browser link click, `gio open mirall://…`. |

**Cold-start queue.** Links can arrive before the renderer mounts. `src/main/main.js` buffers them in `pendingDeepLinks[]` until the renderer calls `bridge.deepLink.subscribe(fn)`, which invokes `deeplink:flush` to drain the queue. Subsequent links are forwarded live as `deeplink` IPC events. `revealWindow()` is called on every dispatch so the window comes to the foreground.

**Renderer routing.** `src/renderer/app.tsx` subscribes once at mount, accumulates a `linkQueue`, and routes each link to the JoinSpaceModal with the code (and name, if v1) prefilled. Subscribing returns the unsubscribe function so React's effect cleanup tears down the listener cleanly.

**Security (v1):** the topic is a shared secret. Anyone with it can join. The deep-link layer adds no new authority — a `mirall://join/<code>` URL is equivalent to pasting `<code>` into the Join dialog. The optional `name` field is purely a UI hint; the joiner can override it.

---

## 6. Space Leave & Cleanup

Leaving is a multi-step operation with progress events (`event:leave-progress`):

1. Cancel all in-flight uploads (`cancelSpaceUploads`) and downloads (`cancelSpaceDownloads`) for the space.
2. **Propagate the leave** — runs *before* the topic disconnect so sockets are still alive:
   - Layer 2 (instant): `sendLeaveFrameToConnectedPeers(spaceId)` broadcasts a `{type: 'leave'}` frame on every active `mirall/handshake` channel. Receivers prune within ~1 RTT.
   - Layer 1 (eventual): `clearOwnMembership(spaceId)` deletes `member/<spaceId>` from the local profile bee. Replication carries the deletion to any peer who connects to this profile bee — including peers who were offline at leave-time.
3. Leave the Hyperswarm topic.
4. `cleanupSpaceDrives`: for every member, close their cached Hyperdrive's blobs + meta cores, then `purgeCoreDk` the discovery keys out of Corestore's RocksDB. Progress is emitted per peer.
5. `cleanupDownloadHistory(spaceId)` — strip the space's entries from the downloads bee.
6. `clearPendingForSpace(spaceId)` — same for pending transfers.
7. `purgeSpaceDrive(spaceId)` — close the local drive, purge its meta + blobs cores, RocksDB compaction.
8. `purgeSpace(spaceId)` — delete the space row from the spaces bee.

`purgeCoreDk` directly writes RocksDB tombstones for `TL_CORE_BY_DKEY`, `TL_CORE`, and `TL_DATA` ranges. We don't use `Corestore.deleteCore()` because it short-circuits when auth blocks are missing, leaving zombie aliases that crash later opens with `STORAGE_EMPTY` / `unslab` errors.

### Interrupted-leave recovery (durable leaving marker)

The leave teardown's edge signals can be lost: a quit mid-teardown used to leave the space record present, and boot's `markOwnMembership` backfill re-PUT `member/<S> = {active:true}` — silently reversing the leave. The teardown therefore persists a **durable `leaving: true` marker** on the space record as its first durable step (`markSpaceLeavingDurable`, riding the `mutateSpace` serialized write chain, before `clearOwnMembership`). A clean leave deletes the whole record (`forgetSpaceRecord`), so the marker only ever survives an interrupted teardown. At boot, before the membership backfill, `resumeInterruptedLeave` completes any space still carrying it: re-runs `clearOwnMembership` (the hard gate — a throw keeps the marker so the next boot retries the del), then best-effort deletes the space's owned/foreign **mount records** (the watcher/mirror restart loops iterate the mount stores, not the space list — a surviving record would re-arm against the forgotten space), tombstones own share ads, and drops the record; the boot call site also purges the space's download-history + pending-transfer rows (spaceId-keyed bee rows no sweep reclaims). Leftover cores/partials are reclaimable garbage for the existing sweeps. A `leaving` space is invisible everywhere it matters: `loadDrives`, the backfill/topic-join loops (`activeSpaces`), `openMemberView`, and the renderer projection (`slimSpaces` / `space:members`) all skip it — and `joinSpace` clears a surviving marker when a rejoin reuses the record, so a failed completion can never delete a space the user rejoined.

### Fold-observed leave revoke (offline approver)

`handleLeaveFrame`'s cleanup triple (`markLeft` + `persistLeftTombstone` + `revokeApproval`) only ran on the live frame, which reaches connected sockets only — an approver offline at leave time never revoked its grow-only vouch, so a departed member re-asserting `member/<S> {active:true}` was silently re-admitted off it. The member view now surfaces `inactive` from `deriveMemberSet` (peers whose record was actually READ as `active:false` — a replicated `del`; never a null/unreplicated peer, never a cascade victim), and `member-registry.applyObservedLeaves` mirrors the frame handler for peers that were in our prior-member belief and now read inactive. The **revoke comes first and gates the tombstone**: a failed revoke leaves the key unhandled (no `markLeft`), and since the surviving vouch keeps it seeded in `prior` at the next view open, the retry is self-sustaining across sessions. Prior-member belief (`entry.prior`, a `Map<key, lastKnownTs>` that also stamps the tombstone's single-clock `leaveTs`) is seeded at view open from the durable roster (`space.members`) **and our own authored approvals** — the roster alone can lose a vouchee that reconcile dropped on a transient null read — and grown with each fold, so the observation also fires when the `del` lands before the session's first fold (approver restarted); `isLeft` guards against double-acting after a received frame. The pure decision is `observedLeavers` in `member-set.js`.

### Membership Reconciliation

The persisted `members` array on each peer's `space/<id>` row is a high-water mark — handshakes only add. To converge it after a leave, three reconciliation triggers run `reconcileMember(spaceId, member)`:

1. **On handshake completion** — for every *other* persisted member of the space, schedule a reconcile pass.
2. **On profile-bee `append`** — when a peer's profile bee gains a new entry (deduped via `profileBeeAppendListeners`), re-reconcile across every space they're a member of.
3. **On worker startup** — `scheduleReconcileForAllSpaces()` walks all spaces × members once, after `loadDrives()` and before `joinSpaceTopic` calls.

Each reconcile pass first short-circuits on **live handshake state** — if the peer is currently in `connectedPeers` for this space, they are by definition an active member and the reconciler returns immediately, skipping any bee reads. This both saves work and prevents false-prune races where the peer's rejoin write hasn't yet replicated to us, or a witness's stale observation hasn't yet been cleared.

When the peer is *not* live, the reconciler evaluates **two evidence sources**:

| Source | Read | Resolution |
|---|---|---|
| **Manifest** (the leaver's own bee) | `readPeerMembership(leaverPk, spaceId)` checks `caps/membership-manifest` then `member/<spaceId>` | `false` ⇒ prune. `true` ⇒ keep (active). `null` ⇒ fall through to witnesses |
| **Witnesses** (any currently-connected peer's bee) | `anyConnectedPeerObserved(leaverPk, spaceId)` — parallel reads of every connected peer's `observed/<leaverPk>/<spaceId>` (gated by `caps/leave-observations`) | Any peer says "yes" ⇒ prune. All say "no" or `null` ⇒ keep |

The live-state check is repeated **once more before the actual prune commits**, since the bee/witness reads are async and a handshake may have landed during them. Pruning only happens if both the evidence reads agree the peer left *and* the peer remains absent from `connectedPeers` after the reads.

To keep witness evidence honest, `handleHandshake` clears our own `observed/<peerPk>/<spaceId>` entry whenever a peer handshakes us for that space — a live handshake is proof they reverted whatever leave we may have witnessed earlier.

Why two sources: the manifest is the leaver's self-declared truth, but it can be unreachable when the leaver is offline. Receiver-side observations are written redundantly by every peer that witnessed the leave (in `handleLeaveFrame` and in the prune branch of `reconcileMember`), so the fact survives the leaver going offline forever — at least one witness has it. Reads are gated by `caps/leave-observations` so old clients that don't publish observations are treated as unknown rather than negative.

Pruning is conservative: only on a positive evidence read does the reconciler delete from the persisted `members` array. `null` (unreachable / no capability) on both sources ⇒ keep. An in-flight dedupe set (`reconcileInflight`) prevents concurrent reconciliations of the same `(spaceId, profileKey)` pair.

When the reconciler prunes, it **cascades**: writes its own `observed/<leaverPk>/<spaceId>` observation. This means a peer who learns about a leave via a witness becomes a witness themselves, propagating the fact transitively across the mesh.

#### Why this isn't timeout-dependent

The earlier design relied solely on the manifest path: receivers had to read the leaver's bee directly (or via a relay that had it cached) within a 5-second window. With observations, the fact is recorded redundantly across every peer who witnesses the leave — receivers offline at leave-time can learn it from any witness's bee, and the leaver doesn't need to be online ever again. Timeouts (5s on bee reads, 500ms flush window in `space:leave`) are now belt-and-braces rather than load-bearing.

---

## 7. Folder Sharing (Owned & Foreign Folders)

Folder sharing lets a user publish a whole local directory tree into a space and lets any peer mirror it to a local folder of their choosing. It sits *on top of* the per-space Hyperdrive — no new core types — by reserving a path **prefix** on the drive per share. Loose files (§3.5) and shares coexist in the same drive; `listFiles` excludes share-prefixed paths from the loose catalog so nothing is double-listed.

### 7.1 Concepts & vocabulary

| Term | Meaning |
|---|---|
| **Share** | A named folder offered into a space. Metadata record (`{ id, type:'owned-folder', name, owner, createdAt, deletedAt? }`) published to the **owner's profile bee** under `share/<spaceId>/<shareId>`, so it replicates to peers. |
| **Share prefix** | The share's files live under `/<ShareName>/…` on the owner's space drive (`sharePrefix(name)` → `'/' + name + '/'`). All file data is ordinary Hyperdrive blobs. |
| **Owned folder / owned mount** | The owner side. A local disk path (`mountPath`) the owner attached to a share; a chokidar watcher keeps the share prefix in sync with that path. Persisted in `mounts-meta` under `owned-folder-mount/…`. |
| **Foreign folder / foreign mount (mirror)** | The consumer side. A local disk path a peer chose to receive a *read-only* copy of someone else's share. The worker continuously materializes the owner's files there. Persisted under `foreign-folder-mount/…`. |

Drive entries carry `{ mtime, hash }` metadata so both sides can diff disk vs. drive by content hash instead of re-uploading/re-downloading unchanged files.

### 7.2 Module map

| Module | Role |
|---|---|
| `src/shared/shares/shares.js` | Share-record CRUD on the profile bee: `publishShare`, `tombstoneShare`, `readOwnShares`, `readPeerShares`, `readPeerShareEntry` (raw, sees tombstones), `isValidShareName`, `ensureSharesCap` (writes `caps/folder-shares`). |
| `src/shared/shares/share-registry.js` | `listSharesForSpace(spaceId)` — aggregates own shares + every member's peer shares into one list tagged with `owner`/`source`. |
| `src/shared/shares/share-catalog.js` | Per-owner replicated share catalog the overlay backend advertises into / lists from (`advertise`, `tombstone`, `listOwnShare`, `listPeerShare`, `watchPeerCatalog`). |
| `src/shared/folders/owned-folders.js` | Owner-side sync: `onFsEvent` (per-watcher-event publish/delete), `initialPublishScan` / `previewInitialPublishScan` (full disk reconcile), periodic reconcile — all dispatched to the overlay backend. |
| `src/shared/folders/foreign-folders.js` | Consumer-side sync: `startForeignLoop`/`stopForeignLoop`, `runMaterializeTick` (30 s poll, serialized per mount), `applyChange` (download one file), `initialMaterializeScan`, `onPeerDriveChanged` (catalog-change-driven debounced tick). |
| `src/shared/folders/mount-store.js` | `mounts-meta` bee CRUD for both mount kinds (`saveOwnedMount`, `getForeignMount`, `listOwnedMounts`, `listForeignMounts`, `findOwnedMountByShareId`, …). |
| `src/shared/folders/mount-validate.js` | `validateMountPath(absPath, role, ctx)` — rejects dangerous targets, returns advisories. |
| `src/shared/folders/path-keys.js` | Pure path math (no imports), unit-tested on all platforms — see §7.6. |
| `src/shared/folders/echo-guard.js` | Per-share TTL set of paths we just wrote, so the watcher ignores our own writes (no upload-of-our-own-download loop). |
| `src/shared/folders/temp-paths.js` | `isEphemeralSourcePath()` — rejects macOS promised-file temps (screenshots, unsaved docs) as share/drop sources so a share never points at a path that vanishes. |
| `src/shared/core/with-timeout.js` | `withReadTimeout(promise, ms, fallback)` — bounds peer reads so one offline peer can't stall share aggregation. |
| `src/shared/transfer/progress-ticker.js` | `makeProgressTicker(total, emit)` — 250 ms-throttled `{bytes,total,speed,eta}`; shared by single-file transfers and folder mirroring. |
| `src/main/owned-folder-watchers.js` | The chokidar watchers (Electron main, see §2 step 12). |

### 7.3 Publishing (owner side)

1. **Mount** (`owned-folder:mount`). After `mount-validate` passes, the worker saves the owned mount, asks main to start a chokidar watcher, and emits `event:owned-folder-mount-status: 'scanning'`.
2. **Initial scan** (`initialPublishScan`). Delegates to the share's content backend (`backend.scan` → the overlay backend), which walks the disk tree stat-only (honoring `ignore` globs — `DEFAULT_IGNORE` covers `.DS_Store`, `Thumbs.db`, `*.partial`, `.git/**`, `node_modules/**`, …), diffs against the share catalog by **size+mtime** (the git-index change signal — no file reads for unchanged files), publishes new/changed files (streaming each **once**, computing its content hash inline), and deletes catalog entries whose disk file is *confirmed* absent (never when the mount root itself is missing). Emits `event:owned-folder-scan-completed { uploaded, deleted, totalOnDisk }`. The content hash is published as entry metadata (mirrors verify by it); it does not drive owner-side change detection.
3. **Live updates** (`onFsEvent`). chokidar `add`/`change` → size+mtime skip vs the catalog entry, else `backend.publishAdd` (single streaming read); `unlink` → `backend.publishDelete` (guarded: root must still exist and the file confirmed gone). `echo-guard` drops events for paths the worker itself just wrote. A 2 s-debounced catch-up reconcile follows quiet periods (macOS fsevents coalescing).
4. **Periodic reconcile.** A recurring timer re-runs the fast (stat-only) diff to heal anything the watcher missed (sleep, dropped events). Every Nth pass (`deepReconcileEvery`, default 4 → ~daily at the 6 h interval) runs **deep** — content-hashing every file to catch an in-place rewrite that kept identical size+mtime.
5. **Relocate** (`owned-folder:relocate`). Moves the mount to a new disk path; runs a **deep** (content-hash) reconcile so an identical tree at the new path — whose mtimes typically differ after a move/copy — relocates with zero re-upload and no mirror churn.
6. **Delete** (`owned-folder:delete`). Stops the watcher, tombstones every drive entry under the prefix, deletes the mount record, and tombstones the share record — which cascades to every peer's mirror.

### 7.4 Mirroring (consumer side)

1. **Mirror** (`foreign-folder:mount`). After `mount-validate` passes (foreign mounts also reject paths inside `~/Downloads`), the worker saves the foreign mount (`enabled:true`) and starts the materialize loop.
2. **Initial materialize** (`initialMaterializeScan`). Lists the owner's share prefix and downloads everything to the mount path, recording each delivered path in `syncedPaths`. Pre-existing user files at the destination are left untouched.
3. **Steady state.** `runMaterializeTick` runs every 30 s *and* on `onPeerDriveChanged` (a debounced tick fired when the owner's catalog appends — so owner edits land in seconds, not after the next poll). Each tick lists the owner's catalog and `applyChange`s the diff: `put` fetches the file by content hash through the overlay (§7.8) into a `.overlay-partial` then renames; `del` unlinks a local file **only if** it's in `syncedPaths`. Per-file progress streams as `event:decoration { channel:'transfer', spaceId, key: shareId+':'+relPath, bytes, total, speed, eta }` with a terminal `done` frame when the fetch settles.
4. **Deletion safety.** `shouldHonorDeletions({ownerOnline, driveCount})` only honors owner-side deletions when the owner is online *and* the listing is non-empty — so a lagged/empty replica can't cascade-wipe a mirror. Mirrors are read-only and idempotent: there's no per-file retry budget; a failed file just retries on the next tick.
5. **Pause / unmount.** `foreign-folder:set-enabled` toggles the loop; `foreign-folder:unmount` stops it and removes the record (and reclaims cached blobs on unmount). Status flows through `event:foreign-folder-mount-status` (`active` / `scanning` / `paused-error` / `paused-enospc` / `mount-point-gone`).

### 7.5 Mount validation (`mount-validate.js`)

`validateMountPath` **rejects** (error codes, surfaced to the user via `errorMessages.ts`): system folders (`MOUNT_FORBIDDEN_SYSTEM`), the app's own storage dir (`MOUNT_FORBIDDEN_APP_DATA`), cloud-sync roots like Dropbox/OneDrive/iCloud (`MOUNT_FORBIDDEN_CLOUD_SYNC`), Windows reserved names / illegal chars (`MOUNT_FORBIDDEN_WIN_RESERVED`), overlap with an existing mount of the same role (`MOUNT_OVERLAPS`), a foreign mount inside `~/Downloads` (`MOUNT_INSIDE_DOWNLOADS`), and non-writable paths (`MOUNT_NOT_WRITABLE`). It also returns non-blocking **advisories** (macOS TCC-gated folders like Desktop/Documents; non-`C:` Windows drives that may be removable/network).

### 7.6 Path math (`path-keys.js`) — pure, cross-platform

No imports, so it's unit-tested on every platform. Key exports: `relToDriveKey` (OS path → always-POSIX drive key), `driveKeyToSegments`, `sharePrefix`, `isInsideShare` / `isInsideAnyShare`, `relPathInShare`, `shouldIgnore` (glob match, basename-first then full path) + `DEFAULT_IGNORE`, `pathsOverlap` / `systemRootViolation` / `isWindowsReservedName` / `cloudSyncHint` (feed the validator), `shouldHonorDeletions` (mirror-delete gate), and `splitFileName` / `nextFreeName` (collision-free naming).

### 7.7 Mount lifecycle & the probe loop

Mounts survive restarts (rehydrated from `mounts-meta` in the worker bootstrap, §2 step 7). A 60 s **mount-probe loop** (§2 step 8) watches every mount's disk path: when a USB drive ejects or a network share drops, the path goes missing → the share flips to `mount-point-gone` and its watcher/loop stops; when it reappears, the watcher/loop restarts. Status is tracked in the worker's `lastMountPointStatus` map and the per-mount `periodicTimers` map.

### 7.8 Content backend (`overlay`)

Every share — folder and loose — moves bytes through the **overlay** content backend (`backends/overlay/`): the canonical bytes are the user's REAL file on disk; nothing is copied into a Hyperdrive blob store.

1. **Publish.** The file is streamed once, computing the whole-file **content hash** and the content-addressed **chunk map** in the same pass, and its metadata is **advertised into the share's replicated catalog** (`share-catalog.js`, keyed by the share's `catalogKey`, SCK-encrypted — §3.7).
2. **Fetch.** A consumer lists the catalog and requests a file *by content hash* from any online holder over the `hyper-overlay/v2` Protomux channel. Chunks are verified against the chunk map as they arrive; the file lands as a visible `<name>.overlay-partial` beside its final name and is atomically renamed on completion, so observers only ever see a missing or a complete file. Serving passes the authorization gates in §16 — a denial is indistinguishable from "I don't hold it".
3. **Resume.** Interrupted downloads persist a **receive journal** (received-chunk bitmap + a snapshot of the streaming hash) in the app-private `journals/` dir, so a resume continues where it stopped instead of re-verifying the partial from scratch. Transfers pause automatically when the holder goes offline and resume on reconnect.

The dispatch seam is `getContentBackend(share)` (`transfer/content-backends.js`): it returns the overlay backend object for `contentMode === 'overlay'` (when the build's overlay flag is on), and the `UNSUPPORTED` sentinel for every other mode — absent, the retired `'eager'`/`'deferred'` modes of older releases, or an unknown future mode — which callers render as unavailable, never routing it to a removed path. Callers (`owned-folders.js`, `foreign-folders.js`, `worker/main.js`) dispatch through it; `test/integration/content-backend-conformance.test.js` locks the contract.

The generic v2 serve/fetch engine is a vendored subset of the `hyper-overlay` project — `backends/overlay/vendor/PROVENANCE.md` documents what was vendored and every local modification; Mirall-specific policy (authorization, catalogs, lifecycle) lives outside `vendor/`. The per-space drive holds no file bytes — it remains solely to carry the member's `driveKey` for the handshake identity binding (§16). §7.3–7.5 above describe the orchestration layer (watchers, scans, reconciles, deletion safety); the advertise/fetch of bytes underneath those flows goes through this backend.


---

## 8. IPC Protocol

### Renderer ↔ Main (Electron `contextBridge`)

`src/preload/preload.js` exposes a single `window.bridge` object. All renderer→main calls go through `ipcRenderer.invoke` (returning Promises) or `ipcRenderer.send/sendSync` for fire-and-forget / synchronous accessors. Main→renderer events go via `webContents.send` and are subscribed through `ipcRenderer.on` wrappers.

| Bridge method | Purpose |
|---|---|
| `pkg()` *(sync)* | Returns the bundled `package.json` object |
| `isDev()` *(sync)* | True if not packaged or `PEAR_DEV_SERVER_URL` is set |
| `getPlatform()` | Returns `process.platform` |
| `getPathForFile(file)` | Resolves a browser `File` to an absolute path via `webUtils.getPathForFile` |
| `applyUpdate()` | Manually triggers `pear.updater.applyUpdate()` — updates normally apply automatically in the background / at quit (§9) |
| `checkForUpdate()` | Manual `pear.updater._debouncedUpdate()`; returns `{triggered, length, fork}` |
| `appVersion()` | Returns the live drive head's `{length, fork, semver}` for the banner |
| `onPearEvent(name, fn)` | Subscribes to `pear:event:updating` / `pear:event:updated` |
| `startWorker(spec)` | Spawns the worker via `pear.run(spec)` |
| `writeWorkerIPC(spec, data)` | Sends an NDJSON frame to the worker's stdin |
| `onWorkerIPC(spec, fn)` | Subscribes to NDJSON frames coming back from the worker |
| `onWorkerStdout/Stderr/Exit(spec, fn)` | Subscribes to the worker's stdio + lifecycle |
| `getWindowBounds()` / `setWindowBounds(b)` | Window-bounds persistence (stored in `config.json`) |
| `getConfig()` *(sync)* / `setConfig(patch)` | Reads the renderer-facing slice of the unified `config.json` (theme, locale, notifications, UI prefs) synchronously at boot / persists a validated patch. Main is the sole writer; the renderer caches the snapshot in `config-client.ts`. |
| `getLocale()` *(sync)* | Returns `app.getLocale()` (BCP-47 string). Used by `src/renderer/i18n.ts` to seed the initial language. |
| `notify(spec)` / `notifyIsSupported()` | Show / probe native OS notifications. `spec` is `{ id?, title, body, urgency?, silent?, icon?, payload?, groupId? }`. |
| `isWindowFocused()` / `focusWindow()` | Renderer can suppress notifications when focused, and raise the window from a notification-click handler. |
| `onNotificationClick(fn)` | Subscribes to `notify:click`; the worker side dispatches the routed payload back through the standard IPC. |
| `showInFolder(fullPath)` | Reveals a file in the OS file manager. Path is rejected unless it's under `os.homedir()`. |
| `setVerbose(on)` | Flips main's live debug-log gate (and the verbose seed for future worker spawns); returns the new state. Used by `mirall.verbose()` (see "Developer console" below). |
| `getIdentityProtection()` | Reports the identity-at-rest protection level (how the KEK that wraps `identity.enc` is provided — §16). |
| `onMainLog(fn)` | Subscribes to main-process log lines (forwarded only while main's debug gate is on); the dev console mirrors them as `[main]` lines. |
| `deepLink.subscribe(fn)` | Subscribes to incoming `mirall://join/<code>` deep links. On first subscribe, drains the cold-start queue via `deeplink:flush`. Returns an unsubscribe function. Payload: `{kind:'join', code, name?}`. See §5.2. |
| `browseShareFolder()` | Opens the OS folder picker (`share:browseFolder`); returns the chosen absolute directory path (or `null`). Used by the add-folder-share / mirror flows. |
| `startOwnedFolderWatcher(shareId, mountPath, ignore)` / `stopOwnedFolderWatcher(shareId)` | Start/stop the chokidar watcher in main (§2 step 12). Invoked by the worker (and available to the renderer) over the `owned-folder:start-watcher` / `owned-folder:stop-watcher` channels. |

### Renderer ↔ Worker (NDJSON over the worker IPC bridge)

`src/renderer/ipc.ts` wraps `window.bridge.write/onWorkerIPC` into a request/response API. The wire format is one JSON object per line. Requests carry an `id`; events don't. Default request timeout is 30 s (`0` for uploads — they stream and must not time out).

**Requests:**

| Type | Payload | Returns |
|------|---------|---------|
| `shutdown` | `{}` | (fire-and-forget; worker exits) |
| `profile:get` | `{}` | `Profile \| null` |
| `profile:set` | `{ displayName, avatar? }` | `Profile` |
| `spaces:list` | `{}` | `Space[]` — rosters are **slim** (`{ publicKey, driveKey, displayName, status? }`, no avatars/catalog keys) + `memberCount`/`pendingCount` |
| `space:members` | `{ spaceId }` | `SpaceMember[]` — the full self-first roster incl. avatars (the only payload that carries them) |
| `space:create` | `{ name, icon? }` | `Space` |
| `space:join` | `{ inviteCode, name?, icon? }` | `Space` |
| `space:update` | `{ spaceId, name, icon }` | `Space` |
| `space:toggle-favorite` | `{ spaceId }` | `Space` |
| `space:invite` | `{ spaceId }` | `string` (formatted invite) |
| `space:leave` | `{ spaceId }` | `{ ok: true }` (progress via events) |
| `members:online` | `{ spaceId }` | `publicKey[]` |
| `files:list` | `{ spaceId }` | `FileEntry[]` |
| `files:add` | `{ spaceId, filePath, fileName, fileSize }` | `{ ok: true }` (timeout=0) |
| `files:remove` | `{ spaceId, path }` | `{ ok: true }` |
| `files:discard-partial` | `{ spaceId, path }` | `{ ok: true }` — deletes the partial file + pending row |
| `files:reveal` | `{ spaceId, path }` | `{ ok: true }` — spawns `open -R` / `explorer /select,` / `xdg-open` |
| `files:download` | `{ spaceId, driveKey, path }` | `{ transferId }` |
| `files:cancel-download` | `{ transferId }` | `{ ok: true }` |
| `storage:info` | `{}` | `{ totalDiskUsage, storagePath, spaces: [...], otherBytes }` |
| `storage:cleanup` | `{}` | `{ purged: number }` |
| `feedback:send` | `{ comment, screenshot? }` | `{ ok: true }` (POSTs to feedback relay at `feedback.mirall.app`) |
| `files:pause-download` | `{ transferId }` | `{ ok: true }` — user-facing pause (auto-resumes like any interrupt) |
| `storage:free-space` | `{}` | `{ freedBytes }` — reclaim resident-cache bytes across every space (called by `StorageSettings.tsx`) |
| `settings:set-download-folder` | `{ path }` | `{ ok: true }` — relocate the loose-file download dir |
| `network:status:get` | `{}` | `{ online, … }` |
| `network:reconnect` | `{}` | `{ ok: true }` — force a swarm reconnect |
| `ping` | `{}` | `{ pong: true, timestamp }` |

**Folder-sharing requests** (see §7):

| Type | Payload | Returns |
|------|---------|---------|
| `share:create` | `{ spaceId, name }` | the share record `{ id, type:'owned-folder', name, owner, spaceId, createdAt }` |
| `share:list` | `{ spaceId }` | `Share[]` (own + every member's, via `listSharesForSpace`) |
| `share:delete` | `{ spaceId, shareId }` | `{ ok: true }` (tombstone) |
| `share:list-files` | `{ spaceId, ownerKey, shareId }` | `[{ relPath, size, hash, mtime, status, localPath? }]` |
| `share:folder-info` | `{ spaceId, ownerKey, shareId }` | `{ fileCount, totalBytes, blobsLength }` |
| `share:read-file` | `{ spaceId, ownerKey, shareId, relPath }` | `{ transferId }` or `{ ok:true, alreadyOwned? }` — download one file from a share |
| `share:reveal-folder` / `share:reveal-file` | `{ spaceId, ownerKey, shareId, relPath? }` | `{ ok: true }` |
| `owned-folder:validate` | `{ mountPath, shareId? }` | `{ mountPath, advisories[] }` |
| `owned-folder:preview` | `{ spaceId, shareId, mountPath, ignore?, previewId? }` | `ScanPreview { toUpload, totalBytes, conflicts, existingAtDestination, perFile[], perFileOmitted? }` — **stat-only**, sent with `timeout:0`; streams `event:owned-folder-preview-progress`. `perFile` is omitted (empty + `perFileOmitted:true`) above 50 action-set files |
| `owned-folder:cancel-preview` | `{ previewId }` | `{ ok: true }` — aborts an in-flight preview walk (rejects it with `PREVIEW_CANCELLED`) |
| `owned-folder:mount` | `{ spaceId, shareId, mountPath, ignore? }` | `{ mount, advisories[] }` (starts watcher + scan) |
| `owned-folder:relocate` | `{ spaceId, shareId, mountPath }` | `{ mount, advisories[] }` (hash-based, no re-upload) |
| `owned-folder:get` | `{ spaceId, shareId }` | the owned mount record or `null` |
| `owned-folder:delete` | `{ spaceId, shareId }` | `{ ok: true }` (unmount + tombstone, cascades to mirrors) |
| `owned-folder:list-all` | `{}` | `[{ …mount, mountPointMissing }]` across all spaces |
| `foreign-folder:validate` | `{ mountPath, shareId? }` | `{ mountPath, advisories[] }` |
| `foreign-folder:preview` | `{ spaceId, ownerKey, shareId, mountPath }` | `{ toDownload, totalBytes, … }` |
| `foreign-folder:mount` | `{ spaceId, shareId, ownerKey, mountPath }` | `{ mount, advisories[] }` (starts materialize loop) |
| `foreign-folder:get` | `{ spaceId, shareId }` | the foreign mount record or `null` |
| `foreign-folder:set-enabled` | `{ spaceId, shareId, enabled }` | `{ ok: true }` (pause/resume) |
| `foreign-folder:unmount` | `{ spaceId, shareId }` | `{ ok: true }` |
| `foreign-folder:list-all` | `{}` | `ForeignFolderMount[]` |
| `mounts:list-all` | `{}` | `[{ role:'owned-folder'\|'foreign-folder', … }]` |

The worker also **receives** an inbound `event:owned-folder-fs-event { shareId, action, relPath, absPath }` frame — chokidar events forwarded from main (§2 step 12), handled by `onFsEvent`.

**Events (worker → renderer):**

| Type | Payload |
|------|---------|
| `event:state` | `{ profile, spaces }` (initial) |
| `event:profile-needed` | `{}` (no profile yet) |
| `event:member-joined` | `{ spaceId, member }` |
| `event:member-left` | `{ spaceId, publicKey }` |
| `event:files-updated` | `{ spaceId }` |
| `event:transfer-complete` | `{ transferId, spaceId, path, localPath }` — notification signal; row status re-derives from `files:list` |
| `event:transfer-paused` | `{ transferId, spaceId, path, reason }` — notification signal; `reason` `'interrupted'`/`'offline'` is toast wording only, never a status source |
| `event:transfer-error` | `{ transferId, spaceId, path, errorCode, errorMessage }` — notification signal |
| `event:transfer-superseded` | `{ transferId, spaceId, path, fileName }` — notification signal |
| `event:leave-progress` | `{ spaceId, step, totalSteps, label }` |
| `event:worker-ready` | `{}` (emitted once after init completes) |
| `event:reconcile` | `{ scope }` — coalesced, level-triggered "state in this scope changed, refetch it" hint (§4.7); fanned from the named `*-updated` pokes via `POKE_SCOPE` (`src/shared/core/ipc.js`) |
| `event:decoration` | `{ channel:'transfer', spaceId, key, bytes, total, speed?, eta?, phase?, verifyFraction?, done? }` — the ONE per-file progress channel (download AND owner-side publish/prepare, tagged `phase:'publishing'\|'preparing'\|'verifying'`); loose rows key by drive path, folder rows by `shareId:relPath` (`decoration-key.js`); cleared only by a terminal `done` |
| `event:awareness` | `{ channel:'serving'\|'serving-detail', spaceId, path, … }` — ephemeral "who is downloading" cross-peer soft-state, re-announced on the ledger sweep and expired by a receiver TTL (never persisted, never a status source) |
| `event:shares-updated` | `{ spaceId }` (a share was created/deleted or the list changed) |
| `event:share-files-updated` | `{ spaceId, shareId? }` (shareId absent = space-wide) |
| `event:owned-folder-mount-status` | `{ spaceId, shareId, status, error? }` (`active`/`scanning`/`paused-error`/`mount-point-gone`) |
| `event:owned-folder-scan-completed` | `{ spaceId, shareId, uploaded, deleted, totalOnDisk }` |
| `event:owned-folder-preview-progress` | `{ previewId, phase, scanned, total, bytes }` (live owned-folder preview scan progress) |
| `event:foreign-folder-mount-status` | `{ spaceId, shareId, status, error?, reason? }` |

### React Integration

| Hook | Requests | Subscribes to |
|------|----------|---------------|
| `useProfile` | `profile:get`, `profile:set` | `event:profile-needed` |
| `useSpaces` | `spaces:list`, `space:create`, `space:join`, `space:leave`, `space:invite`, `space:update`, `space:toggle-favorite` | `event:state`, `event:reconcile` (wildcard members/join-requests), `event:membership-granted`/`-denied`/`-creator-divergence` |
| `useFiles(spaceId)` | `files:list`, `files:remove`, `files:download`, `files:cancel-download`, `files:discard-partial`, `files:reveal` + uploads via `addFileToSpace()` | `event:reconcile` (files + members scopes); publish/prepare progress painted from `useDecorations` |
| `useMembers(spaceId)` | `space:members`, `members:online`, `space:pending-requests` | `event:reconcile` (members + join-requests scopes) |
| `useSpaceMembers(spaceId)` | `space:members` (module-cached full roster for card facepiles) | `event:reconcile` (members scope) |
| `useUpdates` | — (passive: exposes the staged update + `dismiss`) | `bridge.onPearEvent('updated')` via the `updates.ts` singleton |
| `useShares(spaceId, myKey)` | `share:list`, `owned-folder:list-all`, `foreign-folder:list-all` → derives `ShareWithRole[]` (role = `mine`/`browse`/`mirrored`) | `event:reconcile` (shares scope — owned + foreign mount-status both fan a shares hint) |
| `useShareFiles(spaceId, ownerKey, shareId, role)` | `share:list-files`, `share:folder-info`, `share:read-file`, `share:reveal-file` | `event:reconcile` (share-files + files scopes); download + prepare progress painted from `useDecorations` |
| `useDecorations(channel, spaceId)` | — | `event:decoration` — merge-by-key progress map, cleared only by `done` |
| `useOwnedMount(spaceId, shareId)` (`hooks/useFolderMount.ts`) | `owned-folder:get` + `validate`/`preview`/`mount`/`createShareThenMount` helpers | `event:owned-folder-mount-status` |
| `useForeignMount(spaceId, shareId)` | `foreign-folder:get` + `validate`/`preview`/`mount`/`set-enabled`/`unmount` helpers | `event:foreign-folder-mount-status` |
| `useIpcQuery` | generic `request()` wrapper | — |

### Developer console (`window.mirall`)

`src/renderer/dev-console.ts` (imported unconditionally by `main.tsx`) exposes a small debugging surface on **`window.mirall`** — present in every build, including production, reachable through DevTools (F12 / Ctrl-Shift-I / Cmd-Opt-I, §2 step 6). It layers a discoverable command set over the existing plumbing: read-only diagnostics go through the worker RPC (`request`), while logging/version/update/identity go through `window.bridge` (main). Every command logs its result *and* returns it, so both `mirall.spaces()` and `const s = await mirall.spaces()` work. Typed as `MirallDevConsole` in `global.d.ts`.

| Command | Does |
|---|---|
| `mirall.help()` | Print the command table (`console.table`). |
| `mirall.verbose(on = true)` | Flip verbose logging across **worker and main at runtime** — no relaunch, no `MIRALL_VERBOSE` env var. Worker stdout already pipes into this console (`[worker stdout] …`, see `ipc.ts`); main's logs are mirrored as `[main]` lines while its debug gate is on. `verbose(false)` silences both. |
| `mirall.status()` | Swarm / network status (`network:status:get`). |
| `mirall.spaces()` | List known spaces (`spaces:list`). |
| `mirall.members(spaceId)` | Connected members of a space (`members:online`). |
| `mirall.storage()` | Local storage usage (`storage:info`). |
| `mirall.mounts()` | All owned/foreign mounts (`mounts:list-all`). |
| `mirall.profile()` | This peer's profile / identity (`profile:get`). |
| `mirall.features()` | Enabled feature flags (`features:get`). |
| `mirall.version()` | App version — drive `{length, fork, semver}` (`bridge.appVersion()`). |
| `mirall.update()` | Trigger the OTA update lookup now (`bridge.checkForUpdate()`, debounced — §9). |
| `mirall.identity()` | Identity-at-rest protection level (`bridge.getIdentityProtection()`). |

---

## 9. Update System

OTA updates are driven by `pear-runtime-updater` (a dependency of `pear-runtime`), which watches the channel Hyperdrive identified by `package.json#upgrade`. The flow:

1. **Drive subscription.** Main constructs `PearRuntime({ upgrade, store, swarm, version, … })`. The runtime opens a `Hyperdrive` against the upgrade key and joins the discovery key on the swarm as a client. Every append to the drive's metadata core fires the updater's debounced `_update`.
2. **Version check.** `_update` reads `/package.json` from the latest checkout and parses the `version` field as semver. If the remote version is strictly greater than the running app's version, the updater proceeds; if equal, it prefetches the binary so apply is instant when triggered; otherwise it returns silently.
3. **Mirror.** The updater iterates `co.list('/by-arch/<host>/app/<name>')` (where `host = process.platform + '-' + process.arch` and `name = Mirall.app | Mirall.AppImage | Mirall.msix`) and mirrors entries into `~/Library/Application Support/Mirall/pear-runtime/next/<length>.<fork>/by-arch/<host>/app/<name>` (or platform-equivalent userData dir).
4. **Events.** `pear.updater.emit('updating')` fires when the mirror starts; `'updated'` when it completes. Both are forwarded to the renderer via `pear:event:updating` / `pear:event:updated`.
5. **Banner.** `src/renderer/updates.ts` listens for `updated`. In dev builds it simply reloads the window; in packaged builds it reads the staged version via `bridge.appVersion()` (from main — the worker's bootstrap fork/length snapshot can be a stale `0/0` before replication completes) and stores it through the `updateState` reducer. `UpdateBanner` (rendered inside `TopNav`) is passive: "Update to vX available — applied on next start" with a **Dismiss** button only. Dismissing hides the banner; the About screen keeps showing the staged-update notice.
6. **Apply — no user action required.** `pear.updater.applyUpdate()` runs automatically:
   - **Windows / Linux**: main pre-stages the apply in the background the moment `updated` fires — on Windows because `msix-manager.addPackage` takes seconds and would race a quit→relaunch inside `before-quit` (silently failing if the `.msix` is still locked); on Linux so the staged AppImage doesn't sit unused until a clean quit.
   - **macOS**: applies only at quit — a mid-session `fsx.swap` would let any later disk re-read see new-version files mixed with the old in-memory code.
   - **All platforms**: a `before-quit` hook promotes any staged-but-unapplied bundle — `event.preventDefault()` → `await applyUpdate()` → re-`quit()`, because Electron does not await async listeners and the swap must finish before the process exits.
   Platform mechanics: **macOS / Linux** — `fsx.swap(nextApp, this.app)` atomically exchanges `/Applications/Mirall.app` (or the AppImage path) with the mirrored bundle, then `rm -rf next/<length>.<fork>`; **Windows** — `msix-manager.addPackage(nextApp, { forceUpdateFromAnyVersion: true })` re-registers the new MSIX over the existing installation. Main wraps `applyUpdate` with: `process.noAsar` scoping (Electron would otherwise choke on the half-written `app.asar` in the mirror destination), a pre-swap `chmod 0o755` of the staged AppImage (`localdrive` only preserves the executable bit when the drive entry carries `executable:true`), and apply-error recording to `pear-runtime/last-apply-error.json` (cleared on the next successful apply).
7. **Next start runs the new version.** There is no in-app relaunch: the swap has already happened in the background or completes during quit, so the next launch starts the new bundle.

### Version coupling (build ↔ stage)

For `pear-runtime-updater`'s semver comparison to work cleanly, the bundled CI version must equal the drive's `/package.json#version`:

- **CI** (`.github/workflows/build-electron.yml`) patches the bundled `package.json#version` to `<base>-<channel>.<run_number>` for non-prod or the tag value for prod, before forge runs.
- **Seed-host** (`seed-host/scripts/build-stage-artifact.sh`) extracts the bundled version from each per-arch DMG's `Mirall.app/Contents/Resources/package.json` (the two must agree) and writes it to the drive's root `/package.json`. For prod, the explicit `VERSION` arg passed to `release.sh` is validated against the bundled version — operator typos abort the deploy before staging.

This is what eliminates the "banner pops up immediately on every launch" loop: a freshly-installed DMG and the staged drive carry the same version, so `current.compare(remote)` returns `0` and the updater early-returns.

### Diagnostic IPC

| Method | Purpose |
|---|---|
| `bridge.checkForUpdate()` | Manually trigger `pear.updater._debouncedUpdate()`; returns `{triggered, length, fork}`. Useful when the swarm connection has gone stale. |
| `bridge.appVersion()` | Read the live drive head's `{length, fork, semver}`. The banner uses this to render the version. |

Console.log path: `pear.updater.on('error', …)` is wired in `getPear()` so any updater-side rejection surfaces as `pear updater error: …` to stderr instead of a swallowed promise rejection. A global `unhandledRejection` handler is also registered for the same reason.

---

## 10. UI Structure

### Design System — "Editorial Etherealism"

- No-line rule (boundaries via background color shifts, not borders).
- Glass & gradient (`backdrop-filter: blur(…)`, semi-transparent surfaces).
- Material Design 3 palette: dark purple primary, orange secondary, cream surfaces.
- Typography: Plus Jakarta Sans (headlines), Manrope (body), Material Symbols (icons) — all bundled locally under `assets/fonts/` (no CDN).
- Dark mode: class-based toggle on `<html>`, persisted to `config.json` (via `config-client.ts` → main; `setTheme` also tracks the native window background).
- Platform-aware chrome: `src/renderer/platform.ts` stamps `data-platform="darwin|win32|linux|other"` on `<html>` at load; Tailwind applies platform-specific title-bar styling.
- Window bounds persist across launches via `src/renderer/window-bounds.ts` + `bridge.getWindowBounds`/`setWindowBounds`.

### Internationalization

`src/renderer/i18n.ts` initialises `i18next` + `react-i18next` with five locales (`en`, `de`, `fr`, `es`, `it`). Catalog JSON lives at `src/renderer/locales/<code>/{common,errors}.json` and is statically imported (bundled by esbuild — no runtime fetch). Initial language resolution: persisted choice from the unified config (`config-client.ts`, hydrated synchronously from `bridge.getConfig()`) if any → otherwise `bridge.getLocale()` (Electron's `app.getLocale()`) reduced to its primary subtag → otherwise `en`. `setLocale(code)` persists via `config-client` (→ `config:set`) and calls `i18n.changeLanguage()`. `document.documentElement.lang` is kept in sync. Components consume strings via `useTranslation()` from `react-i18next`. `SUPPORTED_LANGUAGES` is exported for the language picker UI to render. Adding a locale: drop a new `src/renderer/locales/<code>/{common,errors}.json` pair, add an entry to `SUPPORTED_LANGUAGES`, register the imports in `i18n.ts`. **German UI:** the project convention is generic masculine — never propose `Kolleg:innen` / `Mitglied*innen` / similar inclusive-language forms.

### Screens

| Screen | Trigger | Key Components |
|--------|---------|----------------|
| **Onboarding** | First launch (no profile) | Avatar upload (`CrystalBackdrop` + `IconPicker`), display-name input |
| **Shared Spaces** | Default after onboarding | `SpaceCard` grid, Create/Join buttons, empty state |
| **Space View** | Click a space | A **Folders Shared** section (`ShareCard` grid, one per owned/mirrored/browsable share) above the loose-files grid (`FileCard`s) + sidebar (`DropZone`, `StorageIndicator`, `MemberCard`s, invite + edit + leave). Dropping a *folder* (or `⌘⇧U`) opens `AddFolderShareModal`; clicking a `ShareCard` navigates to Folder View. |
| **Folder View** | Click a `ShareCard` | Full-screen browse of one share (`screens/FolderView.tsx`): file rows with per-file download/reveal + progress, an owner/role sidebar, and role-dependent actions — **Mirror to Disk** (browse role), pause/resume + unmount (mirrored), or relocate + **Delete Folder** (owned). |
| **Settings** | Gear icon | Profile edit, theme toggle, nav to Storage / About |
| **Storage Settings** | From Settings | `StorageIndicator` per space, total / other breakdown, cleanup button → `storage:cleanup` |
| **About** | From Settings | Version info, "Send feedback" → `FeedbackModal` |

Modals rendered from root: `FeedbackModal` (sends a comment + `modern-screenshot` capture via `feedback:send`).

### Toast Notifications

In-app transient feedback primitive for foreground actions. Lives at `src/renderer/components/toast/` — `ToastProvider` (context + state + timers), `ToastContainer` (bottom-centered fixed stack at `z-[60]`, above modals at `z-50`), `Toast` (single item), `useToast` (consumer hook), `types.ts`. Mounted as the **outermost** provider in `app.tsx` so any descendant — including modals — can surface a toast.

Four variants: `error` / `warning` / `success` / `info`, each backed by Material Design 3 colour-token pairs (`bg-{name}` + `text-on-{name}`, with `error` using the `*-container` variant pair). Behaviour: stacks up to 4 visible (oldest dropped on overflow), dedupes by stable `id` (showing the same id replaces in-place), auto-dismisses after a configurable duration (default 5 s), pauses the timer on hover and resumes on leave, supports an optional inline action button. Honours `prefers-reduced-motion` via `motion-reduce:` Tailwind variants. ARIA: `role="alert" aria-live="assertive"` for errors, `role="status" aria-live="polite"` for the rest.

**Foreground vs OS notifications.** Toasts and the OS-notification system (`window.bridge.notify` via `src/main/notifications.js` — see §8) are deliberately separate. Toasts are for foreground feedback on something the user *just did* (folder dropped that we don't accept, validation failed, action confirmed). OS notifications are for background events the user may not be looking at (transfer complete, peer joined). They route through different IPC, obey different OS muting rules, and have different ARIA semantics. New error-surfacing code defaults to toasts unless the event is genuinely async-and-passive.

**Dev hook.** When `window.bridge.isDev()` returns true (non-packaged build, or `PEAR_DEV_SERVER_URL` set), `ToastProvider` attaches its API to `window.__toast` for console-driven testing — `__toast.error('...')`, `__toast.warning('...')`, etc. Packaged production builds never set the global (the IPC handler in `src/main/main.js` returns `false` when `app.isPackaged && !PEAR_DEV_SERVER_URL`). Typed via `declare global { interface Window { __toast?: ToastApi } }` so no `any`/`unknown` casts.

Current consumer: `DropZone` (folder-drop rejection — `webkitGetAsEntry().isDirectory` check).

### Component Library

Custom components built with Tailwind + React Aria. Since the #199 reorg they're grouped on disk under `src/renderer/components/`: `primitives/` (Button, IconButton, Toggle, Badge, Avatar, Icon, Modal, ProgressBar, StatusBadge, CopyButton), `cards/` (FileCard, MemberCard, ShareCard, SpaceCard), `modals/` (the `*Modal` components), `layout/` (TopNav, UpdateBanner, PageHeader, SectionHeading), `widgets/` (ActionMenu, DropZone, StorageIndicator, IconPicker, FilePath, NetworkStatusIndicator, CrystalBackdrop, ConnectivityToastBridge, DownloadProgressLane), and `toast/`.

| Component | Purpose |
|-----------|---------|
| `TopNav` | Fixed glassmorphism header (logo, update banner slot, settings + feedback buttons, profile avatar) |
| `UpdateBanner` | Passive banner under the top nav: staged-update version + "applied on next start" + a Dismiss button; publishes its height as `--banner-h` so screens shift down instead of being overlaid |
| `SpaceCard` | Gradient icon + member avatars + active badge + favourite toggle |
| `CreateSpaceModal` / `EditSpaceModal` | Name + `IconPicker`; edit also surfaces Leave |
| `JoinSpaceModal` | Invite-code input + optional local name + icon |
| `LeaveSpaceModal` | Undownloaded-file warning + progress bar driven by `event:leave-progress` |
| `InviteModal` | Copy invite code for an existing space |
| `DropZone` | Drag-and-drop + file picker. Files → `addFileToSpace`; a dropped **folder** routes to `AddFolderShareModal` (share-it flow). Rejects ephemeral/promised drop sources (`temp-paths`). |
| `FileCard` | Renders one of the 9 states; per-state action button (Download / Cancel / Resume / Discard / Reveal / Remove) |
| `StatusBadge` | File-state chip used inside `FileCard` |
| `ActionMenu` | Three-dot menu with state-appropriate actions (Reveal, Discard partial, Remove local copy, etc.) |
| `RemoveFileModal` | Delete-confirmation with "members keep their copy" warning |
| `MemberCard` | Avatar + name + online/offline dot |
| `StorageIndicator` | Local-mirror progress bar (used in Space View + Storage Settings) |
| `FeedbackModal` | Textarea + optional screenshot toggle; POSTs through `feedback:send` |
| `IconPicker` | Material Symbols picker used by space create/edit |
| `CrystalBackdrop` | Decorative gradient-blob backdrop for onboarding |
| `ToastProvider` / `ToastContainer` / `Toast` | Foreground transient-notification primitive (see "Toast Notifications" above). Consumed via `useToast()`; dev-only `window.__toast` for console testing. |
| `ShareCard` | One folder share in Space View — name, owner avatar, role badge (Shared by you / Mirrored / Browse), mount status, and an action menu (mirror, pause/resume, locate, unmount, delete). |
| `AddFolderShareModal` | Two-step (edit → preview) owner flow: pick a folder (`browseShareFolder`), name + validate the share, preview the scan, then `createShareThenMount` (creates the share record, mounts, rolls back the share if the mount fails). |
| `MirrorFolderModal` | Two-step consumer flow: shows owner + folder size (`share:folder-info`), picks a destination, always shows the read-only warning, then `createForeignMount`. |
| `ScanPreviewModal` | Shared preview step for add-folder / mirror / relocate — summary cards (to-upload / to-download / conflicts / already-present) + a collapsible per-file list. |
| `DeleteFolderShareModal` | Owner-side confirm for `owned-folder:delete` (warns it removes the share for everyone / stops mirrors). |

**Shared primitives** (used across all screens):

| Primitive | Standardizes |
|-----------|--------------|
| `Button` | `primary` / `secondary` / `danger` variants, sizes, optional icon — replaces ad-hoc button classes (also unifies destructive + cancel styling). |
| `IconButton` | Circular icon-only button with a **mandatory** `ariaLabel` (a11y). |
| `Toggle` | Switch with label + description, `role="switch"` + `aria-checked`. |
| `Badge` | Inline uppercase pill (status/role chips). |
| `Avatar` | Image-or-initials with size scaling + accessible alt. |
| `PageHeader` | Back-button + title + optional subtitle (Folder View, settings sub-screens). |
| `SectionHeading` | `h2` section label. |
| `ProgressBar` | `role="progressbar"` with `aria-valuenow` + optional meta line; non-cancellable (caller owns controls) — used for mirror file rows. |
| `FilePath` | Monospace path with middle-truncation (directory ellipsizes, filename stays); `splitPathForDisplay()` in `renderer/sharePaths.js`. Renders FS paths consistently everywhere. |

---

## 11. Module Structure

| Path | Purpose |
|------|---------|
| `src/main/main.js` | Electron main process. Argv parsing, BrowserWindow, PearRuntime bootstrap, OTA wiring, worker IPC bridge, custom-protocol + deep-link dispatch (`mirall://`, see §5.2), lifecycle. Hosts the asar `child_process.spawn` shim (see §2). |
| `src/preload/preload.js` | `contextBridge.exposeInMainWorld('bridge', …)`. Only file that touches both Electron internals and the renderer's window object. |
| `src/main/notifications.js` | Native `Notification` IPC handlers + `shell:showInFolder`. Per-platform fallback icon resolved against `resources/{darwin/icon.icns,win32/icon.ico,linux/icon.png}`. |
| `src/main/deeplink.js` | `parseDeepLink(url)` — validates `mirall://join/<code>` URLs, decodes the invite envelope (via dynamic import of `src/shared/invite-envelope.js` since main is CJS), returns `{kind:'join', code, name?}` or `null`. |
| `src/worker/main.js` | Bare worker entry. Wires `Bare.IPC` to `src/shared/core/ipc.js`, runs the bootstrap sequence, shuts down on parent disconnect. |
| `src/worker/package.json` | `"type": "module"` so Bare imports the worker as ESM. |
| `src/main/owned-folder-watchers.js` | chokidar watchers for owned-folder shares (Electron main; Bare can't recursive-watch). Forwards `add`/`change`/`unlink` to the worker as `event:owned-folder-fs-event`. See §2 step 12, §7. |
| `src/main/loose-file-watchers.js` | Second chokidar host (Electron main) — watches individual absolute paths for in-place loose-file shares; fans each `add`/`change`/`unlink` out to every space watching that path. See §2 step 12. |
| `src/shared/` | Modules loaded by the Bare worker (and a couple dynamically imported by main, e.g. `invite-envelope.js`). See below. |
| `src/renderer/` | Renderer source (TypeScript + React, compiled to `assets/dist/`). |
| `assets/` | Shipped renderer assets (formerly `ui/`): `index.html`, `fonts/`, `theme-bootstrap.js` (pre-paint dark-mode script, no FOUC), and the esbuild/Tailwind output under `dist/`. |
| `resources/` | Platform build assets (formerly `build/`), organized per target: `darwin/` (`icon.icns`, `entitlements.plist`, `dmg/`), `win32/` (`icon.ico`, `AppxManifest.xml`, `msix-assets/`), `linux/` (`AppRun`, `icon.png`, `icons/<N>x<N>.png`), plus `tray/` (tray icons). |
| `forge.config.js` | Electron-forge configuration (packagerConfig, makers, hooks for forwarding `UPGRADE_KEY` to `package.json#upgrade`, MSIX manifest version patching). |
| `seed-host/` | Seed-host setup, scripts, systemd unit, sudoers fragment, READMEs. See §13. |
| `scripts/` | Local build / signing / diagnostic utilities — `generate-tray-icons.mjs`, `export-translations.mjs`, `build-app-image.sh`, `sign-windows-local.ps1`, `uninstall-windows.ps1`, `uninstall.sh`, `inspect-store.mjs`. |
| `test/` | Five-layer test suite (`unit` / `integration` / `flow` / `raw` / `frontend`) — a CI gate. See §15. |
| `eslint.config.mjs` | ESLint flat config incl. `eslint-plugin-jsx-a11y` (accessibility lint — a `npm run build` / CI gate). |
| `tailwind.config.js` | Design-system tokens + content globs. |
| `tsconfig.json` | `target: ES2022`, `jsx: react-jsx`, `rootDir: src/renderer`, `outDir: assets/dist` (typecheck only — esbuild is the actual bundler). |

### `src/shared/` (worker modules)

Since the #199 reorg the shared data layer is split into domain subfolders (`core/`, `spaces/`, `shares/`, `folders/`, `transfer/`, `storage/`, `telemetry/`); `invite-envelope.js` stays at the root as the one module reached across processes (worker + the Electron-main deep-link parser).

| File | Purpose |
|---|---|
| `core/runtime-config.js` | Bootstrap config getter/setter populated from the worker bootstrap message. |
| `core/errors.js` | `AppError`, `ErrorCodes`, `classifyTransferError`, `isRetryableTransferError`, `friendlyTransferError`. |
| `core/ipc.js` | NDJSON router + pre-start message queue. Wraps `Bare.IPC`. |
| `core/logger.js` | Scoped logger with `--verbose` gating (default level: warn). |
| `core/store.js` | Corestore init, `createBee()`, `createDrive()` factories. |
| `core/channel.js` | `deriveChannel({dev, appVersion})` — maps a build's version string to its release channel (`dev`/`staging`/`prod`). Dependency-free so it's unit-testable; consumed by `telemetry/feedback.js`. |
| `core/paths.js` | `getDownloadDir()` + download-path resolution. |
| `core/with-timeout.js` | `withReadTimeout` — bound peer reads so one offline peer can't stall aggregation. |
| `spaces/space.js` | Space metadata, invite code format, drive open/purge, `purgeCoreDk()` RocksDB tombstone writer. |
| `spaces/profile.js` | Profile bee CRUD + `openProfileBee(key)` for peer avatars. |
| `shares/shares.js` | Share-record CRUD on the profile bee + `caps/folder-shares`. See §7.2. |
| `shares/share-registry.js` | `listSharesForSpace` — aggregate own + peer shares. §7.2. |
| `shares/share-catalog.js` | Per-owner share catalog (`advertise`/`tombstone`, materialized-hash tracking, `watchPeerCatalog`) backing the overlay content model. |
| `folders/owned-folders.js` | Owner-side publish/reconcile (`onFsEvent`, `initialPublishScan`, periodic reconcile) — dispatches to the overlay backend. §7.3. |
| `folders/foreign-folders.js` | Consumer-side mirror loop (`runMaterializeTick`, `materializeOnceCatalog`/`materializeOverlayFile`, `onPeerDriveChanged`). §7.4. |
| `folders/mount-store.js` | `mounts-meta` bee CRUD for owned + foreign mounts. §3.6. |
| `folders/mount-validate.js` | `validateMountPath` — reject/advisory rules for mount targets. §7.5. |
| `folders/path-keys.js` | Pure cross-platform path math + ignore-glob + mount-safety helpers; heavily unit-tested. §7.6. |
| `folders/echo-guard.js` | Per-share TTL set so the watcher ignores the worker's own writes. |
| `folders/temp-paths.js` | `isEphemeralSourcePath` — reject promised/temp drop sources. |
| `transfer/files.js` | File listing (state resolver over the loose-in-place catalog), reveal, downloaded-file verification + history, owned-source map. |
| `transfer/loose-overlay.js` | In-place loose files (single files shared from their on-disk location) served over the overlay instance. |
| `transfer/content-backends.js` | The content-backend seam: `getContentBackend(share)` → the overlay backend for `contentMode:'overlay'`, else the `UNSUPPORTED` sentinel (eager/deferred/unknown all degrade). Locked by `content-backend-conformance.test.js`. §7.8. |
| `transfer/backends/overlay/` | The overlay content backend: `overlay-backend.js` (the 8-method contract + serve/fetch + sender-side download indicator), `overlay-instance.js` (the `HyperOverlayV2` instance lifecycle + channel attach), `overlay-download.js` (the shared consumer engine), `vendor/` (the vendored `hyper-overlay` v2 subset). §7.8. |
| `transfer/download-dest.js` | `resolveDest` — collision-free Downloads destination naming. |
| `transfer/partial-sweep.js` | `cleanupOrphanedOverlayPartials` — boot sweep of unreferenced `.overlay-partial` files. |
| `transfer/transfer-status.js` | `pausedStatusFor` — derives the paused sub-status of a transfer row. |
| `transfer/pending-transfers.js` | Pending-transfers Hyperbee CRUD (resume across restarts). |
| `transfer/swarm.js` | Hyperswarm + Protomux handshakes, per-space identity binding (§16), overlay channel attach, presence/membership gossip. |
| `transfer/progress-ticker.js` | `makeProgressTicker` — 250 ms-throttled progress, shared by transfers + mirroring. |
| `storage/storage.js` | Per-space byte accounting + orphan-core cleanup. |
| `telemetry/feedback.js` | HTTPS POST (via `bare-https`) of feedback caption + optional screenshot to the relay. Sends `x-mirall-install-id`, `x-mirall-version`, `x-mirall-channel` headers. |
| `telemetry/install-id.js` | Lazy-mints and persists an opaque per-install UUID at `<storage>/install-id`, used for rate-limit bucketing on the relay. |
| `invite-envelope.js` *(root)* | `encodeInvite({topic, name})` / `decodeInvite(input)` — accepts both v0 (bare 64-char hex) and v1 (base64url JSON `{v:1,t,n?}`) envelopes. ESM, dynamically imported by `src/main/deeplink.js`. Twin to `src/renderer/invite-envelope.ts`. See §5.1. |

### `src/renderer/` (renderer)

| File / dir | Purpose |
|---|---|
| `main.tsx` | `createRoot(...)` — imports `./platform.ts` and `./theme.ts` for side effects. |
| `app.tsx` | Root component — screen routing, theme init, window-bounds restore, feedback modal mount. |
| `ipc.ts` | Worker IPC wrapper — `request()`, `subscribe()`, `addFileToSpace()`. Sits on top of `window.bridge.write/onWorkerIPC`. |
| `updates.ts` | Singleton update state — listens to `bridge.onPearEvent`, fetches version via `bridge.appVersion`, drives `UpdateBanner`. |
| `types.ts` | `Profile`, `Space`, `SpaceMember`, `FileEntry`, `FileStatus`, `Transfer`, `UpdateInfo` — plus the folder-sharing types: `Share` / `ShareType` / `ShareRole` / `ShareWithRole`, `OwnedFolderMount`, `ForeignFolderMount` / `ForeignMountStatus`, `ShareFileEntry` / `ShareFileStatus`, `MountValidationResult` / `MountValidationAdvisory`, `ScanPreview` / `ScanPreviewEntry`. |
| `sharePaths.js` | `splitPathForDisplay()` — middle-truncation math for `FilePath`. |
| `errorMessages.ts` | Maps backend error codes (incl. `MOUNT_*`) to i18n keys via `mountErrorI18nKey()`. |
| `keyboard/` | App-wide keyboard layer: `KeyboardProvider` + `registry`, `accelerator` (chord parsing) + `AcceleratorLabel`, `CommandPalette` (`⌘K`), `ShortcutsHint`, `known-commands.ts`. Screens register commands via `useRegisterCommand` (e.g. SpaceView: `⌘U` add files, `⌘⇧U` add folder, `⌘J` join, `⌘⇧L` leave). |
| `utils.ts` | `formatSize` / `formatSpeed` / `formatEta` / `getFileIcon` / `resizeAvatar` / `fileName`. |
| `platform.ts` | Sets `data-platform` on `<html>`. |
| `theme.ts` | Dark-mode toggle persistence. |
| `window-bounds.ts` | `restoreWindowBounds` / `trackWindowBounds` (uses `bridge.getWindowBounds` / `setWindowBounds`). |
| `global.d.ts` | Type declarations for `window.bridge` (the contextBridge surface). |
| `hooks/` | `useIpc`, `useProfile`, `useSpaces`, `useFiles`, `useMembers`, `useSpaceMembers`, `useDecorations`, `useUpdates`, plus folder sharing: `useShares`, `useShareFiles`, `useFolderMount` (`useOwnedMount`), `useForeignMount`. |
| `screens/` | `Onboarding`, `SharedSpaces`, `SpaceView`, `FolderView`, and the settings family — `Settings` (shell) + `Account`, `AppearanceSettings`, `GeneralSettings`, `NotificationSettings`, `NetworkStatus`, `StorageSettings`, `AboutSettings`. |
| `components/` | UI components, grouped into `primitives/`, `cards/`, `modals/`, `layout/`, `widgets/`, and `toast/` subfolders (all listed in §10). |
| `styles/tailwind.css` | Font faces, custom utilities, glass classes. |
| `i18n.ts` | `i18next` + `react-i18next` setup. Initial-locale resolver (persisted → system → `en`), `setLocale(code)`, `SUPPORTED_LANGUAGES` (`en`/`de`/`fr`/`es`/`it`). |
| `invite-envelope.ts` | `encodeInvite` / `decodeInvite` for the renderer (TS twin of `src/shared/invite-envelope.js`). Used by `InviteModal` to generate `mirall://join/<code>` links and by `JoinSpaceModal` to accept either format on paste. See §5.1. |
| `locales/<code>/{common,errors}.json` | Translation catalogues, statically imported by `i18n.ts` so esbuild bundles them — no runtime fetch. |
| `notifications/` | `dispatcher.ts` (suppress-when-focused gate + `bridge.notify`), `click-router.ts` (handles `bridge.onNotificationClick` → `bridge.focusWindow` + screen routing). OS-level / background-event notifications — distinct from in-app toasts (`components/toast/`). |
| `components/toast/` | Foreground in-app notification primitive — `ToastProvider`, `ToastContainer`, `Toast`, `useToast`, `types`. Mounted outermost in `app.tsx`. Dev-only `window.__toast` global gated on `bridge.isDev()`. |

---

## 12. Dependencies

> Versions are indicative; `package.json` is authoritative and minor carets drift with Renovate.

### Worker / main process (Bare-compatible runtime deps)

| Package | Version | Purpose |
|---------|---------|---------|
| `pear-runtime` | 1.3.1 | Embedded runtime — provides updater, drive replication, worker spawn (exact pin, no caret) |
| `corestore` | ^7.9 | Multi-core storage with namespaces |
| `hyperdrive` | ^13.3 | P2P filesystem |
| `hyperbee` | ^2.27 | Key-value store on Hypercore |
| `hyperswarm` | ^4.17 | Peer discovery + NOISE connections |
| `hypercore-crypto` | ^3.6 | Random bytes, key generation |
| `b4a` | ^1.8 | Buffer utilities |
| `bare-fs` | ^4.5 | Filesystem |
| `bare-path` | ^3 | Path utilities |
| `bare-os` | ^3.8 | OS utilities |
| `bare-subprocess` | ^6 | `spawn` for reveal-in-finder |
| `bare-https` | ^3 | Feedback relay POST |
| `sodium-native` | ^5.1 | Cryptographic primitives |
| `paparam` | ^1.10 | CLI flag parsing |
| `which-runtime` | ^1.3 | Detect Bare/Node/Electron + platform/arch |
| `chokidar` | ^4.0 | Recursive filesystem watcher for owned-folder shares. **Electron-main only** (Node, not Bare) — see §2 step 12, §7. |

### Renderer

| Package | Version | Purpose |
|---------|---------|---------|
| `react` / `react-dom` | ^19.2 | UI framework + DOM rendering |
| `react-aria` | ^3.47 | Accessible UI primitives |
| `@react-stately/collections` / `@react-stately/menu` / `@react-stately/tree` | ^3 | State containers used by react-aria components |
| `i18next` / `react-i18next` | ^26 / ^17 | Renderer translation framework — catalogues bundled at build time |
| `modern-screenshot` | ^4.6 | Screenshot for feedback modal |

### Build / dev

| Package | Purpose |
|---------|---------|
| `electron` ^42 | Host runtime (devDep — bundled into the artifact by forge) |
| `@electron-forge/cli` ^7.11 | Build orchestration |
| `@electron-forge/maker-dmg` | macOS DMG packaging |
| `@electron-forge/maker-msix` | Windows MSIX packaging |
| `app-builder-lib` ^26 | AppImage assembly used by `scripts/build-app-image.sh` |
| `electron-forge-plugin-prune-prebuilds` | Strips unused native prebuilds |
| `electron-forge-plugin-universal-prebuilds` | macOS universal binary handling |
| `esbuild` ^0.28 | Renderer bundler |
| `typescript` ^6 | Compiler / typechecker |
| `@tailwindcss/cli` ^4.2 / `tailwindcss` ^4.2 | CSS build |
| `concurrently` ^10 | `npm run dev` orchestration |
| `serve` ^14 | Local HTTP server for `assets/` in dev mode |
| `brittle` ^4 | Test framework (run via `brittle-node` / `brittle-bare` per layer) |
| `bare-runtime` ^1.28 | Bare VM used by the integration (`test:bare`) and flow worker-subprocess layers; a `postinstall` symlinks `node_modules/.bin/bare` |
| `eslint` + `eslint-plugin-jsx-a11y` ^6.10 | Accessibility lint — runs in `npm run build` and CI (`npm run lint:ci` over `src`). A gate. |
| `@axe-core/react` ^4.11 | Dev-only runtime a11y checker (logs WCAG violations to the console; not CI-blocking). |

---

## 13. Build & Distribution Pipeline

### Renderer build

```
src/renderer/**/*.ts(x) ─tsc --noEmit─►  typecheck only
src/renderer/main.tsx          ─esbuild─────►    assets/dist/main.js          (bundled, minified, sourcemap with --sources-content=false)
src/renderer/styles/tailwind.css ─@tailwindcss/cli─►  assets/dist/app.css     (--minify)
```

Scripts:
- `npm run build` → typecheck + bundle JS + bundle CSS
- `npm run dev` → esbuild watch + tailwind watch + `npx serve -l 5173 assets` + `electron-forge start --no-updates` (uses `PEAR_DEV_SERVER_URL`)
- `npm run typecheck` → `tsc --noEmit`
- `npm test` → `npm run test:node && npm run test:bare`

### Distributable build (electron-forge)

CI workflow `.github/workflows/build-electron.yml`:

1. **Resolve channel + version** from the trigger (tag → prod, `release/*` branch → staging, `workflow_dispatch` → operator-selected, default → dev). Version is `<base>-<channel>.${GITHUB_RUN_NUMBER}` for non-prod or the tag string for prod.
2. **Patch `package.json#version`** to that resolved string before forge runs. Also overrides `package.json#upgrade` from the channel-specific `UPGRADE_KEY_*` secret via `forge.config.js`'s `readPackageJson` hook.
3. **Make** per platform:
   - macOS — `electron-forge make --platform=darwin` produces a DMG. Codesigned + notarized in CI when `APPLE_*` secrets are set.
   - Linux — `electron-forge package --platform=linux` produces an unpacked tree, then `scripts/build-app-image.sh` assembles it into an `.AppImage` via `app-builder-lib`. Bundles a custom `resources/linux/AppRun` that exports library paths and exec's the binary with `--no-sandbox`. After `app-builder` finishes, the script swaps the stock libfuse2-based AppImage runtime for `VHSgunzo/uruntime` in extract-and-run mode (`URUNTIME_MOUNT=0`) so the resulting AppImage runs on Ubuntu 24.04 / Fedora 40+ where `libfuse2` is no longer installed by default. Pinned via the `URUNTIME_VERSION` constant in `build-app-image.sh`; bump by editing that line and triggering a dev build.
   - Windows — `electron-forge make --platform=win32` produces an MSIX package with the channel's publisher / version. Signed locally afterwards by an operator (Certum cloud cert via `scripts/sign-windows-local.ps1`) — CI never holds the signing key.
4. **Upload to R2** at `s3://$R2_BUCKET/desktop/channels/<chan>/<archPath>/Mirall.<ext>` (or `desktop/releases/v<version>/...` for prod). Windows MSIX uploads to `<arch>/unsigned/Mirall.msix`; the signed copy lands at `<arch>/signed/Mirall.msix` after the local signing step.

### Seed-host release pipeline

The seed host is a stateful Linux VM that holds the production Pear corestore. Scripts in `seed-host/scripts/`:

| Script | Run on | Purpose |
|---|---|---|
| `release.sh <vm> <channel> [version]` | dev machine | SSHes to the VM and runs `deploy.sh`. For prod, also creates a Hetzner VM snapshot via `hcloud server create-image` and prunes old snapshots. |
| `deploy.sh <channel> [version]` | seed VM | Orchestrates the full deploy: `[1/6]` pull artifacts, `[2/6]` build stage dir, `[3/6]` (prod only) stop seed service, `[4/6]` `pear stage`, `[5/6]` `pear release`, `[6/6]` cleanup, restart seed service. |
| `pull-artifacts.sh <channel> [version]` | seed VM | `aws s3 sync` from R2 to `~/deployment-input/<channel>/`. |
| `build-stage-artifact.sh <input> <output> <version-or-empty> <upgrade-key>` | seed VM | Extracts each per-arch DMG via `7z` → strips xattr-as-file artifacts → places `Mirall.app` under its own `darwin-<arch>` path. Reads bundled version from each `Mirall.app/Contents/Resources/package.json` (the two must agree); for prod, validates against the explicit VERSION arg. Writes the drive's `package.json` with `{name, productName, version, upgrade}`. |
| `mirall-seed.service` | seed VM (systemd) | Runs `pear seed production` continuously. Survives reboots. Stop/start called from `deploy.sh` during prod release via the `pearel-systemctl` sudoers fragment. |

### Backup strategy

Production releases trigger a Hetzner VM snapshot via `release.sh` (using the `hcloud` CLI on the dev machine). Snapshots capture the full disk including the live corestore. Rotation keeps the most recent 3 by default (override via `MIRALL_SNAPSHOT_KEEP`). Disaster recovery is "restore from snapshot in the Hetzner UI." Dev/staging deploys do not snapshot — those drives are regenerable from source. No in-VM tarballs are created and no data is rsync'd to dev machines.

### Asar packaging

`forge.config.js` runs the package step with `asar: { unpack: '*.{node,bare}', unpackDir: '{src/worker,src/shared,node_modules,resources}' }` so the host code (`src/main/`, `src/preload/`, `assets/`, `package.json`) lands in a sealed `app.asar` archive (~3 MB) and everything else is materialised into a sibling `app.asar.unpacked/` directory. Files inside the asar are not casually browseable — extracting them takes `npx @electron/asar extract`. The asar IS NOT compressed; the goal is binary form + light obfuscation, not size reduction. Disk usage is unchanged from the loose-files layout.

What stays inside the archive:

- `src/main/` (`main.js`, `preload.js` lives under `src/preload/`, `notifications.js`, `deeplink.js`, `owned-folder-watchers.js`)
- `assets/index.html`, `assets/dist/{main.js,app.css}`, `assets/fonts/`, `assets/theme-bootstrap.js`
- `package.json`

What is unpacked (forced onto the real filesystem, via `unpackDir`/`unpack`):

- `src/worker/`, `src/shared/`, `node_modules/**` — Bare is a separate C runtime with **no asar awareness**. It can't read `.bare` modules, JS sources, or the worker entry from inside the archive. `bare-sidecar` also `chmod`s its own `bare` binary on first launch, which would fail on a read-only asar path.
- All `*.{node,bare}` files (matched by basename) — `dlopen` / Bare's loader can't read from asar.
- The whole `resources/` dir — the per-platform Notification + tray icons are handed to native APIs (`NSImage` / Toast / libnotify) that don't traverse asar. `nativeImage.createFromPath` was rejected because it only decodes PNG/JPEG, not `.icns` / `.ico`.

What is fully ignored (excluded from the bundle entirely):

- `resources/darwin/dmg/`, `resources/darwin/entitlements.plist`, `resources/win32/AppxManifest.xml`, `resources/win32/msix-assets/`, `resources/linux/AppRun`, `resources/linux/icons/`. These are package-time-only inputs read by forge makers and `scripts/build-app-image.sh` from the source tree, never from the shipped bundle.

The asar setting also forces a small spawn shim in `src/main/main.js` (see §2 step 10): `require.resolve()` returns asar paths, but `child_process.spawn` hands paths straight to the OS, which can't walk into a flat archive. The shim rewrites `app.asar/` → `app.asar.unpacked/` for both the executable and argv, fixing both the bare-binary spawn and the worker-entry argument in one place.

OTA updates are unaffected: the per-channel Hyperdrive ships the entire `.app` / `.AppImage` / `.msix` (which includes both `app.asar` and `app.asar.unpacked/`), and `fsx.swap` operates on the bundle root.

### MSIX signing (Windows-specific)

CI cannot hold the Certum hardware-token signing material, so the flow is:
1. CI builds an unsigned `Mirall.msix` and uploads to R2 at `<chan>/win32-x64/unsigned/Mirall.msix`.
2. Operator runs `scripts/sign-windows-local.ps1` on their Windows box (with the Certum SimplySign client unlocked). Script downloads unsigned, signs, uploads to `<chan>/win32-x64/signed/Mirall.msix`.
3. `seed-host/scripts/build-stage-artifact.sh` requires the signed MSIX; aborts if missing. This is a hard gate — every prod release goes through the local signing ceremony, no exceptions.

---

## 14. Known Limitations & Future Work

- **Invite links gate reading, not knocking.** The topic inside an invite is a discovery capability: anyone holding a code can join the swarm topic and send join requests until the link expires or is revoked (`invite-envelope.js` carries expiry + auto-approve policy; `revokeInvite` kills a link). Read access, however, always requires approval — the SCK handout (§16).
- **Checksum-failed transfers need manual intervention.** Transfers auto-pause and auto-resume across owner offline/reconnect, but a transfer that failed its integrity check (`TRANSFER_CHECKSUM`) is never auto-resumed — re-fetching from the same holder would fail the same way — so it waits for an explicit resume or discard (`overlay-download.js#resumeForOwner`).
- **Very large listings are capped, not paged.** File listings return at most a configurable cap of entries (`runtime-config.js#getListFilesCap`); a share with more files than the cap doesn't render fully, and paging/virtualization is future work. Very large folders (hundreds of thousands of entries) also remain a memory-scaling risk for the single Bare worker.
- **Departed members can linger under some offline patterns.** Leave convergence (§6) relies on the leaver's own manifest plus witness observations; while the leaver and every witness are offline, a departed member stays in peers' rosters until that evidence replicates.
- **Frontend tests are local-only.** The renderer (`test/frontend/`) suite drives the real Electron app through the macOS accessibility tree (`agent-desktop`), which headless CI can't do — so it runs on a dev machine and isn't part of the CI gate. The other four layers (unit/integration/flow/raw) *are* gated. See §15.
- **The dev channel has no seeder — by design.** Production (`mirall-seed.service`) and staging (`mirall-seed-staging.service`) auto-start on the seed VM; dev builds are validated by direct download/install, and OTA round-trips are exercised on staging/prod.
- **Asar is binary, not compressed.** Renderer + main are sealed into `app.asar` (~3 MB) so casual users can't browse the source, but the worker tree (`src/worker/`, `src/shared/`, `node_modules/`) lives outside in `app.asar.unpacked/` because Bare can't read asar. True compression / bytecode obfuscation would require an additional layer (e.g. `bytenode` for the renderer); deferred until there's a concrete threat model.
- **Custom `--storage` redirects userData.** Passing `--storage <dir>` now also calls `app.setPath('userData', dir)`, so `config.json` and the OTA's applied-version marker share the custom dir. This enables clean multi-instance dev testing; dev data written by older builds may still sit split across two locations.

---

## 15. Testing & Accessibility

Every feature and behaviour change ships with test coverage at the layer(s) it touches, and any UI it adds/changes meets the accessibility bar — this is part of the change, not a follow-up. The discipline (change-type → required-coverage matrix, the a11y bar, red-first bug fixes) lives in **`.claude/testing.md`**, summarized for contributors in `CONTRIBUTING.md`; each `test/<layer>/` dir has a `README.md` describing that layer.

### Five test layers

| Layer | Dir | Runner | Scope |
|---|---|---|---|
| **Unit** | `test/unit/` | `brittle-node` (Node) | Pure logic, no I/O: `path-keys`, validators, invite/ipc/share encoders, `echo-guard` TTL, ignore-matchers, runtime-config. |
| **Integration** | `test/integration/` | `brittle-bare -j 4` (Bare) | Single-peer data layer against real `corestore`/`hyperdrive`/`hyperbee` (no mocks): owned-folder publish/reconcile, foreign-mirror materialize, mount validation, share registry, transfers, cleanup-orphans, witness-prune. |
| **Flow (2+ peer)** | `test/flow/` | `brittle-node` orchestrating **real worker subprocesses** over a hermetic `hyperdht` testnet | End-to-end P2P: membership convergence, transfers, owned-folder replication, foreign-mirror, move/copy/delete, leave/reconcile, offline behaviour, multi-peer (3–4). |
| **Raw (holepunch)** | `test/raw/` | `brittle-node` (Node) | Primitive guarantees of the deps themselves (Hyperdrive replication/deletes/blob streaming, Hyperbee mutations, Corestore namespacing) — no Mirall code. A trust-but-verify layer. |
| **Frontend (UI)** | `test/frontend/scenarios/` | `node test/frontend/run.mjs` driving the **real Electron app** via `agent-desktop` (macOS AX tree) | User-facing flows incl. owner-side filesystem operations (the only layer exercising the real chokidar → publish → replicate → materialize path). **Local-only** — headless CI can't drive the AX tree. |

`test/helpers/` provides the multi-peer/single-peer harness: `peer.js` (`launchPeer`, `connectInSpace`, `addPeerToSpace`, `waitForCatalogEntry`), `store.js` (`freshPeer` — single in-process peer), `owned.js` (`setupOwnedShare`, `setupSelfMirror`), `fixtures.js`, `testnet.js` (`localTestnet` — 3-node DHT bootstrap), `fake-ipc.js`.

### Scripts & CI gate

- `npm test` = `test:node` (`brittle-node` over `test/unit`, `test/raw`, `test/flow`) + `test:bare` (`brittle-bare -j 4` over `test/integration`).
- `npm run lint` = `eslint src` (incl. jsx-a11y) — also part of `npm run build`. CI uses `lint:ci`, which adds the comment-hygiene gate (`scripts/check-comment-hygiene.sh --strict` — comments must be purpose-driven and self-contained, see `CONTRIBUTING.md`).
- CI (`.github/workflows/test.yml`) runs typecheck + `lint:ci` + `knip` + `test:node` + `test:bare` across a `node` job and a `bare` job (the latter ensures `bare` is on PATH). The frontend suite + manual VoiceOver spot-check are run **locally** for UI-affecting changes.

### Accessibility bar (non-negotiable for UI)

- **Static (CI gate):** `eslint-plugin-jsx-a11y` must pass. Every interactive control needs an accessible name/role/state.
- **Runtime (dev):** `@axe-core/react` logs WCAG violations to the console in dev; a UI change introduces no new violations.
- **Targetability:** if `agent-desktop` can't reach a control by name/role, that *is* the a11y gap — fix it in the control (this is how empty-named buttons get caught). The frontend suite doubles as the proof.

---

## 16. Identity & Security Model

### Master secret (M) & key derivation

A 32-byte **master secret (M)** is the root of all local key material: every writable core's keypair and every local encryption key derives from it (`src/shared/core/store.js`, `identity-keys.js`). M is stored only in `identity.enc` beside the store, wrapped by a **KEK** (key-encryption key) from a pluggable unlock provider — by default the OS keychain via Electron's `safeStorage` (`src/main/identity-kek.js`, `src/shared/core/unlock-providers.js`, `identity-envelope.js`, `identity-resolve.js`). The wrap flow guarantees the RocksDB seed never doubles as the identity: a fresh install generates an independent random M, while a store that predates the envelope preserves its seed as M, then replaces the persisted seed and best-effort-drops the superseded seed blocks.

### Encryption at rest

Local-only metadata bees (`LOCAL_BEE_NAMES`: spaces-meta, downloads-meta, pending-transfers, reclaim-meta, mounts-meta, app-migrations) are encrypted with an M-derived key. Stores that peers must read are not encrypted at that layer: the profile bee replicates in plaintext; share catalogs are encrypted with the space's SCK instead, so only members can read them (§3.7).

### Space content key (SCK)

A per-space symmetric key that encrypts the space's catalogs — **possession is read access**, which makes membership approval a cryptographic gate rather than a UI state. The creator derives a space's SCK deterministically from M (nothing to store); joiners receive it at approval, sealed to their bound signer key (`src/shared/transfer/sck-seal.js`), and keep it in the space-keys vault (`space-keys.enc`, wrapped by an M-derived key).

### Handshake identity binding

Every identity-asserting frame on the `mirall/handshake` channel (handshake, membership request/grant, leave) carries a signature binding the sender's profile key to the socket's Noise key — and, on handshakes, to its per-space drive key — verified in `src/shared/transfer/handshake-guard.js`. Frames are therefore attributable: a connected peer cannot impersonate another member, kick a third party out of member lists, or claim a foreign drive as its own.

### Membership

Joining is request → approval. A **membership grant** hands over the sealed SCK and asserts the space's member-set root, authenticated by the granter's identity binding (a plaintext SCK is refused as a downgrade). Member rosters fold as an **OR-Set** (adds/removes with tombstones) so concurrent joins and leaves converge; the set's root of trust is pinned to the space creator and adopted only from authenticated assertions — a TOFU-pinned root (e.g. from a bearer invite hint) stays provisional until confirmed.

### Serve authorization

File bytes are served only when three gates pass (`src/shared/transfer/backends/overlay/overlay-authorize.js`): (1) the requester's claimed profile key is Noise-authenticated on the requesting socket, (2) a per-requester rate limit admits the request, (3) the requester is an approved member of a space advertising that content hash. A denial is observationally identical to "I don't hold this file", so membership cannot be probed.

### Resource bounds

`src/shared/core/runtime-config.js` centralizes DoS/resource budgets: caps on peer-supplied data (e.g. avatar data-URI length), read timeouts that bound how long an offline peer can stall aggregation, and the serve-gate rate limiter.

---

## 17. Glossary

Stack terms (the [Holepunch](https://docs.pears.com) building blocks):

- **Bare** — minimal JavaScript runtime the worker runs on (not Node; `bare-fs`, `bare-path`, … are its stdlib).
- **Hypercore** — signed append-only log, the primitive under everything; a "core".
- **Hyperbee** — key/value database on a Hypercore; a "bee".
- **Hyperdrive** — filesystem abstraction on Hypercores; a "drive".
- **Corestore** — manages all cores in one storage directory (RocksDB-backed).
- **Hyperswarm** — DHT peer discovery + encrypted socket connections.
- **Noise** — the encrypted transport protocol under every peer socket; a socket's *Noise key* identifies its endpoint.
- **Protomux** — multiplexes several protocol channels over one socket.

Mirall terms:

- **Space** — a shared topic peers join; the unit of membership, discovery, and sharing.
- **Loose file** — a file shared individually into a space; peers download it explicitly (never auto-synced).
- **Share / owned folder** — a local directory tree published into a space by its owner ("owned" = this peer is the owner).
- **Foreign folder / mirror** — another member's share materialized read-only to a local folder.
- **Mount** — the association between a share and a local disk path, on either side.
- **Catalog** — the replicated, SCK-encrypted listing of a share's files (path, size, mtime, content hash).
- **Overlay (backend)** — the content-addressed serve/fetch engine: bytes come from holders' real files on disk, addressed by content hash.
- **Content hash / chunk map** — a file's whole-file hash and its per-chunk hash list; both are computed at publish and verified at fetch.
- **M (master secret)** — the 32-byte root secret all writable-core keys and local encryption keys derive from; stored wrapped in `identity.enc`.
- **KEK** — key-encryption key that wraps M; provided by a pluggable unlock provider (OS keychain by default).
- **SCK (space content key)** — per-space key that encrypts catalogs; possession = read access; handed to joiners at approval.
- **Identity binding** — the signature tying a peer's profile key to its socket's Noise key (and per-space drive key); what makes frames attributable.
- **Membership grant** — the approval message carrying the sealed SCK and the authenticated member-set root.
- **OR-Set** — conflict-free add/remove set used to fold member records from multiple writers.
- **LWW** — last-writer-wins: newest timestamp takes the value (used for single-value records).
- **TOFU** — trust on first use: accepting a key provisionally until an authenticated assertion confirms it.
- **Tombstone** — a record marked deleted (`deletedAt`) but kept, so replicas can tell "removed" from "never seen".
- **Capability flag** — `caps/<feature>` marker in the profile bee; absence means "this peer doesn't publish that data", never "the data is gone".
- **Presence lease** — a short-lived, re-announced liveness claim; expiry means the peer is treated as offline.
- **Hint / `event:reconcile`** — the coalesced worker→renderer signal "state in this scope changed, refetch it".
- **Partial** — an in-progress download file (`*.partial` / `*.overlay-partial`), atomically renamed on completion.
- **Pending transfer** — the persisted row describing an unfinished download; the source of resume and of paused/error UI states.
- **Channel** — a release line (`dev` / `staging` / `prod`), each an independently-keyed update drive.
