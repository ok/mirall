# Mirall — Solution Architecture

> **Scope.** Authoritative for process model, data model, networking, IPC, update mechanics, security model. Cited, never duplicated: `build-process.md`, `design.md`, `testing.md`, `dependency-updates.md`, `package.json`. Section numbers are stable — README, CONTRIBUTING, `build-process.md` and code comments cite them.

## 1. Overview

A serverless P2P file-sharing desktop app: an Electron host that embeds `pear-runtime` for OTA only, plus a Bare worker holding the entire data layer. Users keep a profile, join **spaces**, and exchange files directly with peers.

A space has two sharing modes, stored as separate share ids in one per-owner catalog (`LOOSE_SHARE_ID` for loose files, §3.7), so a file lives in exactly one place:

1. **Loose files** — never synced automatically; peers pick what to download. UI state follows the canonical file-state model (§3.5).
2. **Folder shares** — an owner-mounted directory tree, kept in step with disk by a watcher; a peer who **mirrors** it gets the files materialized continuously. Both opt-ins are required (§7).

§16 is the identity & security model; §17 the glossary.

### How it ships

- **Dev** — `npm start` (OTA off); `npm run dev` serves the renderer from a watch build via `PEAR_DEV_SERVER_URL`. A source `package.json` has no `upgrade` key, so OTA never runs from source.
- **Installers** — `.dmg`, `.msix`, `.deb`, `.AppImage` → `build-process.md`.
- **OTA** — follows a per-channel Pear Hyperdrive (§9). Off on `.deb` installs, which update through the package manager.

**Channels.** `dev`, `staging` (shipped publicly as the beta, `-beta.N`), `prod` — each its own drive and upgrade key, injected by CI (`UPGRADE_KEY_<CHANNEL>`). `prod` builds on a `v*` tag; any channel via `workflow_dispatch`. The bundle version must equal the drive's `/package.json#version` → `build-process.md` "Version coupling". Seed-host operations are documented privately.

**Stack.** Versions: `package.json` and §12. Placement rules: `chokidar` runs in Electron main only (Bare has no recursive watch); `bare-*` modules are worker-only; `purgeCoreDk()` uses `hypercore-storage` internals (transitive dep) for raw RocksDB range deletes.

---

## 2. Process Architecture

**Main** owns lifecycle, window, OS integration, the OTA updater and the filesystem watchers. The **renderer** is sandboxed and reaches main only through `window.bridge`. The **worker** (Bare child process) owns all P2P, storage and transfer logic. Main relays NDJSON between renderer and worker and parses only its own control frames.

```
┌─────────────────────────────┐ window.bridge ┌───────────────────────────┐
│ MAIN  src/main/             │ ◄───────────► │ RENDERER  src/renderer/   │
│  pear-runtime: OTA only,    │               │  app:// origin, sandboxed │
│   own corestore + swarm     │               └───────────────────────────┘
│  worker host · config.json  │                            ▲ pear:worker:ipc/
│  chokidar watchers          │                            │ stdout/exit
└─────────────────────────────┘                            │
   │ hello, bootstrap,    ▲ main-request frames            │
   ▼ fs events, relayed   │ (watch, download roots)        │
┌───────────────────────────────────────────┐              │
│ WORKER  src/worker/main.js + boot.js      │ ─────────────┘
│  Corestore: profile bee, encrypted local  │
│   bees, share catalogs, intents           │
│  Swarm (mirall/handshake) + ContentSwarm  │
│  overlay content backend                  │
└───────────────────────────────────────────┘
                  ▼  replication + handshake / content channels → PEERS
```

### Main process (`src/main/`)

`src/main/main.js` only wires modules. Invariants:

- **Asar shim first.** `src/main/asar-spawn.js` is main's first statement: `bare-sidecar` captures `spawn` at load, and without the `app.asar/` → `app.asar.unpacked/` rewrite the packaged worker spawn fails with ENOTDIR.
- **Argv never aborts boot.** `src/main/boot-argv.js` strips deep links (Win/Linux pass them as positionals) and turns any parse bail into a warning. Flags: `--storage <dir>` (also redirects `userData`, so instances never share a `config.json`), `--no-updates`, `--hidden`.
- **Updater.** `src/main/updater.js` builds `PearRuntime` lazily, with its own Corestore under `<dataDir>/pear-runtime/` (never the worker's store); without an upgrade key the updater is `null`. Windows/Linux apply a staged update as soon as it arrives. macOS waits for quit, because swapping mid-session lets disk reads mix new files with old in-memory code. `src/main/apply-error.js` reports a failed apply only while it names the running version, and never deletes the record on read.
- **Worker spawn.** `src/main/worker-host.js` spawns only allowlisted specifiers (`src/shared/contract/workers.js`), then writes `hello` (IPC protocol version) and `bootstrap`. The bootstrap is the worker's whole starting state (storage, version, upgrade key, prefs, relay config, feature flags, test overrides) and carries the only two secrets main passes, `identityKEK` and `relaySeed`; runtime config never stores them. A failed write of either frame destroys the worker and fails the spawn, because the worker never asks for its bootstrap again. The KEK comes from `safeStorage` (`src/main/identity-kek.js`). Without secure storage, main refuses to start rather than write an unprotected identity.
- **Window.** It loads `app://-/index.html`, a privileged scheme, so origin and CSP `'self'` survive a reload, with `sandbox` and `contextIsolation` on.
- **Config.** `config.json` holds preferences only. `src/main/config-store.js` is its only writer (debounced atomic writes, merge-over-defaults). The renderer reads a sync snapshot and adopts the sanitized snapshot main returns from each patch.
- **Quit order** (`src/main/lifecycle.js`, one run per process): mark quitting → stop watchers → flush config (watchers can dirty it) → stop workers (shutdown frame, SIGTERM 3 s, SIGKILL 5 s) → apply update, the only step that may defer the quit. A failing step never skips later ones.
- **Deep links.** `open-url`, `second-instance` and cold-start argv all go through `dispatchDeepLink`. `src/main/deeplink.js` accepts only a `mirall://join/<code>` whose invite decodes. Links queue until the renderer calls `deeplink:flush`. Linux desktop-entry handling: `src/main/xdg-integration.js`, §5.2.
- **Reveal allowlist** — the only app state main holds. `shell:showInFolder` accepts home, the configured download folder, and the per-space roots the worker pushes (`downloads:roots`). The pushed roots are dropped when that worker exits.
- **Watchers.** The worker requests them over the main-request bus (commands named in `src/shared/contract/main-requests.js`). `src/main/watch-host.js` is the sole chokidar owner. Options are per instance, so it keeps a native and a lazy polling instance and routes by `looksLikeNetworkPath`, because a native watch on a network mount emits nothing and fails silently. It also stops a watcher after 5 errors in 10 s. `src/main/folder-watchers.js` keys roots by `shareId` (owned) or `spaceId:shareId` (mirror), and the newest caller adopts a live key after a worker respawn. `src/main/loose-file-watchers.js` fans a path's events out to every space watching it.

### Renderer (`src/renderer/` → `assets/dist/`)

`src/renderer/ipc/ipc.ts` is the worker channel. Requests are `{ id, type, …args }` and answers `{ id, data }` or `{ id, error, code }`. Any other `type` is an event for `subscribe()`, and cancel is a control frame. The worker starts on the first request, and `src/renderer/ipc/worker-respawn.js` owns respawns. After a respawn, the `event:worker-ready` epoch tells the renderer to resync its query store in place.

`src/renderer/ScreenRouter.tsx` ends on a `never` binding, so every screen in `src/renderer/shell/navigation.ts` must be routed. An action aimed at a screen that is not mounted yet travels as `pendingSpaceAction` state, never as a window event, which cannot be retried and is lost on a slow mount. The update banner is passive (§9).

### Worker (`src/worker/main.js` entry + `src/worker/boot.js` root)

The **entry** owns the crash backstop, the pipe and its close hooks, bootstrap, membership control, handler registration (handlers in `src/worker/ipc/`), the shutdown deadline and `Bare.exit`. The **composition root** builds subsystems with their collaborators, starts them in a declared order, and returns `close()`, which reverses it. Neither `boot()` nor `close()` exits the process, which makes in-process restart testable.

Bootstrap:

1. `createIPC(Bare.IPC)`.
2. `installCrashBackstop` **before the first `await`** (it escalates only once boot completes).
3. `await ipc.bootstrapPromise`. An unsupported protocol version exits with `WORKER_EXIT_PROTOCOL_MISMATCH`, which the renderer does not respawn. Then `setRuntimeConfig(bootstrap)`.
4. `boot()` starts two tiers *(cited as `§2 boot step N`)*. The **durable** tier holds every Corestore-session handle plus the recorders the teardown writes through, and closes **last**:
   1. `Store` → identity unlock → `runMigrations('durable')` → `SpaceKeysVault` → `ProfileBee` → `SpacesBee` → `DownloadsBee` → `PendingTransfersBee` → `MountsBee` → `IntentsBee`.
   2. `AuditLog`: writable before anything worth recording. A failed start loses rows, never boot.
   3. `ServeLedger` next, so it closes just before the log, whose close drains the `serve.completed` rows the ledger reaps.
   4. `OwnCatalogs` → `PeerCatalogs`.

   The **runtime** tier closes first:
   5. Manifest caps and `runMigrations('content')`, before any publish scan or overlay index open. Then `MountsRuntime` is constructed without side effects, then `OverlayBackend` (engines built per lifetime, never at import), `PublishService`, `OwnedFolders`, `ForeignMirrors`, `EchoGuardPurge`, `PeerWatch`.
   6. Interrupted-leave resume → `intents.recover()` → download-root hydration → membership backfill. This comes after every reconciler registers and before the swarm, so a topic join cannot re-arm a space the pass is about to forget.
   7. `MemberViews` before the swarms: a handshake that lands on the registry's no-op defaults reads every peer as disconnected, and without a seeded tombstone set a membership request is mishandled.
   8. `Swarm` → `ContentSwarm` (needs the control DHT) → `applyRelayConfig()` on **both**, because a relay on the control swarm alone leaves file bytes unrelayed. Swarm hooks are `require()`d constructor deps, so a missing hook fails boot by name. Then leftover sweeps, topic joins and pending-leave replay.
   9. `MountsRuntime` starts: it resumes mounts and arms the 60 s probe (`mount-point-gone` ↔ restart). Then `Sweeps`.
   10. `cleanupOrphanedData()` runs only after everything else starts. Opening catalogs mid-startup leaves an owner that answers IPC but never serves. It must also follow the content migrations (they copy from plaintext catalogs) and the overlay start (overlay keys are `[]` while it is down). It **hard-deletes cores** — §14.
   11. `Supervisor` last, so it stops first. It recovers a *unit* inside a subsystem, never a subsystem, because every holder of a replaced subsystem would keep a dead instance. It abandons rather than drains, because a socket carries all of a peer's cores and a stalled `close()` never settles. The stall test is **no progress**, not elapsed time (`src/shared/core/pass-liveness.js`). The durable tier is unsupervised. Escalation: 2 bad probes condemn a unit, which gets at most 3 recoveries (`src/shared/core/supervision.js`) → 10 uncaught errors in 60 s exit with `WORKER_EXIT_UNSTABLE`, latched (`src/shared/core/crash-backstop.js`) → the renderer respawns with backoff (5 retries, gives up after 3 unstable lifetimes in 10 min; then requests fail fast).
5. Register handlers; `ipc.start()` flushes frames queued during boot.
6. Every attaching client gets `event:worker-ready` (`{ epoch, head }`) and then `event:state` or `event:profile-needed`, computed per client so a reloaded renderer still receives them.

**Shutdown.** A closed pipe detaches the client. `src/worker/connection-lifecycle.js` then stops the worker, because a worker with no client is an orphan holding the store lock. A `shutdown` request does the same. `safeShutdown` keeps the first reason's exit code, aborts in-flight requests, and runs `root.close()` under a 4 s hard deadline. `close()` pauses the supervisor, broadcasts departure and halts publishing before anything closes (the departure datagram must leave UDX before sockets drop). It then waits a **ref'd** 150 ms (an unref'd timer would empty the loop for an in-process caller) and closes the runtime tier and then the durable tier, each within its own budget. `Store` close names any Corestore session still open. Downloads need no suspend step: pending rows (§3.4) rebuild resume state.

**Durable intents** (`src/shared/core/intents.js`). A flow spanning stores writes `intent/<kind>/<id>` first and deletes it last. The reconciler registered for that kind (`src/shared/folders/folder-intents.js`) finishes it idempotently at next boot. Recording is best-effort: refusing the user's action over bookkeeping is worse. A reconciler that throws keeps its record. An unknown kind is left untouched, so a downgrade cannot eat a newer build's work. `space:leave` keeps its own `leaving` marker but shares teardown order with the boot pass via `src/shared/spaces/membership/leave-state.js`.

**Bounds** (runtime-config levers; `0` disables). `downloadConcurrency` (6) gates fetches through a FIFO semaphore with express lanes for user clicks, so a reconnect backlog cannot start a scheduler per pending row. `peerFrameBurst` and `peerFrameMaxBytes` meter and cap **every** peer frame before decode. `peerCatalogCacheLimit` (64) is a refcounted LRU; watchers and reads pin entries, because eviction closes live handles.

**Contract package** (`src/shared/contract/`). The request, event, error, frame, limit, status, `Scope` and audit-kind vocabulary that all three runtimes share. Its `.js` files import only siblings, so esbuild, Bare and CJS `require()` can all load them. They are JSDoc-typed `.js` because neither Bare nor CJS main rewrites `.js` specifiers to `.ts`; the `.ts` files there are type-only. Enforced by `test/unit/contract-package.test.js` and `test/typecheck/contract.assert.ts`.

**Handler table** (`src/shared/core/handler-table.js`). Registering a name `src/shared/contract/requests.js` does not declare, or registering one twice, **throws at boot**. Payloads are validated before the handler runs, and a bad one is refused with `INVALID_ARGUMENT`. Fields are required unless marked `optional`, `null` counts as missing, and `max` is a transport bound.

**Import-time rules** (nothing done at import is reachable by any `close()`): no module-level timers, since periodic work goes through a subsystem's `this.timers` (eslint `moduleLevelTimerRestrictions`, `test/invariants/module-level-timers.test.js`); no import-time construction that arms a resource; and no TDZ in an import cycle, since each cycle member must import first in a fresh Bare process (`test/integration/import-time.test.js`).

---

## 3. Data Model

All persistent state lives in one Corestore at the worker bootstrap's `storage` path (`src/shared/core/store.js`). Every bee is `utf-8` keys / JSON values. Each bee is owned by one `Subsystem` that opens and closes it; a handle must be closed by its owner, never probed by whoever cached it, because a Hyperbee whose store closed underneath still reports `closed === false`. Every prefix scan uses `prefixRange` (`src/shared/core/bee-keys.js`), never a `'\xff'` bound.

| Bee | Owner | Replicates | At rest |
|---|---|---|---|
| `profile` | `src/shared/spaces/profile.js` | yes — peers read it | plaintext |
| catalog `space-catalog-<spaceId>-<driveSuffix>-e1` | `src/shared/shares/own-catalog.js` | yes — members read it | SCK at the space's epoch |
| `spaces-meta`, `downloads-meta`, `pending-transfers`, `mounts-meta`, `audit-log`, `reclaim-meta`, `app-migrations` (`LOCAL_BEE_NAMES`) | one module each | never | `deriveContentKey(M,'metadata-bees')`, core keyPair from `name + '/v2'` |
| `intents` | `src/shared/core/intents.js` | never | **plaintext** (not in `LOCAL_BEE_NAMES`) |

A new local bee must be added to `LOCAL_BEE_NAMES`: `createLocalBee` throws otherwise, and the list drives the plaintext→encrypted metadata migration and the leftover-scan wanted set. The `/v2` keyPair exists because a plaintext core can never be reopened with an `encryptionKey`.

### 3.1 Profile bee (`profile`) — replicated

The profile core's key (`core.key`, the hash of its single-signer manifest — not the signer public key) **is the peer identity**. Only this peer writes it; every row below is authored by the profile's owner.

| Key | Value | Rule |
|---|---|---|
| `displayName` / `avatar` / `publicKey` | string / JPEG data URI or null / core-key hex | avatar is 160×160, capped by `maxAvatarBytes` |
| `caps/<feature>` | `true` | capability flag, below |
| `member/<spaceId>` | `{ active, ts }` | liveness; a departure is written as `active:false`, not deleted, so its `seq` marks the log position after which this peer's vouches are discounted. Readers treat absent = inactive |
| `approved/<spaceId>/<joinerKey>` | `{ ts }` | authorization vouch; grow-only, retracted only by `del` (`revokeApproval`) |
| `request/<spaceId>/<joinerKey>` | `{ displayName, avatar, ts }` | join-request receipt, so every member sees the banner |
| `denied/<spaceId>/<joinerKey>` | `{ ts }` | dismissal; wins over the receipt by LWW on `ts` |
| `invite/<spaceId>/<inviteId>` | `{ autoApprove, expiresAt, created }` | reusable until expiry; revoke = `del` (§5) |
| `share/<spaceId>/<shareId>` | `{ id, type:'owned-folder', name, displayName?, owner, spaceId, createdAt, contentMode:'overlay', catalogKeyEnc, catalogEpoch, deletedAt? }` | how peers discover shares. `name` is immutable (it keys claims and pending rows; `displayName` is the label). Delete = tombstone `deletedAt`, so "owner removed it" ≠ "not replicated yet" (§7) |
| `mirror/<spaceId>/<shareId>` | `{ shareId, state:'syncing'\|'synced'\|'paused', mountedAt, ts, unmirroredAt? }` | written by the mirroring peer; soft tombstone `unmirroredAt`; per-key serialized RMW (`src/shared/folders/mirror-records.js`) (§7.3) |
| `drive/<spaceId>` | participation id hex (§3.5) | deleted in the same batch as the `member/` departure |
| `loosecatEnc/<spaceId>` + `loosecatEpoch/<spaceId>` | catalog key hex + int (absent ⇒ 0) | written in one batch that also deletes plaintext `loosecat/<spaceId>`, so exactly one form is ever set |

`member/`, `approved/`, `request/`, `denied/`, `invite/` are gated by `caps/membership-manifest`; `share/` by `caps/folder-shares`; `mirror/` by `caps/folder-mirrors`. The two tombstone fields differ (`deletedAt` vs `unmirroredAt`); reading the wrong one turns an unmirror into a fresh mirror.

**Capability flags, not versions.** When a feature's missing data must read as "unknown" rather than "no", it publishes `caps/<feature> = true` **before** its first data key. With no flag, readers treat the data as unknown. A flag is never reused for an incompatible meaning. Flags let independent features ship and retire independently, which one version field cannot. Absence that is already unambiguous (no avatar) needs no flag.

**Reading peers' profiles.** The process holds exactly one long-lived session per peer (`src/shared/spaces/peer-profile-watch.js`), whose `append` listener drives admission re-evaluation, the share-list refresh and the audit observer. Every other read is `withPeerBee` (`src/shared/spaces/peer-bee.js`): open, pull head, read, close, under one deadline and a session-level timeout so an abandoned read cannot pin the core. Budgets: `src/shared/core/runtime-config-schema.js` (`peerReadTimeoutMs`, `interactiveReadTimeoutMs`, `admissionReadTimeoutMs`).

### 3.2 Spaces bee (`spaces-meta`) — local

| Key | Value |
|---|---|
| `space/<spaceId>` | space record (below) |
| `left/<spaceId>/<memberKey>` | `{ leaveTs }` — a leave we observed; keeps the leaver subtracted from our fold across restarts until a strictly-later `member/` ts |
| `pendingleave/<spaceId>` | `{ topic, ts }` — our leave not yet acked by any co-member; re-announced until one does (§6) |

`spaceId` = first 16 hex chars of the 32-byte topic. The record always holds `name, icon, topic, created, members, driveSuffix, schemaVersion:2`; every other field is a single-writer latch listed in the header of `src/shared/spaces/space.js` (e.g. `status:'pending'` until the grant, `epoch`, `leaving`, `downloadFolder`). `schemaVersion !== 2` is a legacy space and is refused. `members` holds the *other* members as `{ publicKey, displayName, avatar, looseCatalogKeyEnc?, looseCatalogEpoch?, looseCatalogKey? (plaintext, pre-encryption peers), status? }`. Every record write goes through one per-space promise chain (`mutateSpace` / `mutateMembers`), because concurrent handshakes would otherwise lose roster updates.

`driveSuffix` (random 8 bytes hex) is minted on create/join and names both the participation id and the own catalog core. A leave deletes the record, so a rejoin mints a fresh suffix: peers see a new participation and a new catalog, and stale blocks under a reused deterministic key can never resurface.

### 3.3 Downloads bee (`downloads-meta`) — local

`downloads-meta` has three namespaces, told apart by prefix (`src/shared/transfer/files.js`):

| Key | Value |
|---|---|
| `<spaceId>:<filePath>` | claim `{ downloadedAt, localPath, hash }` — `localPath` is the real landed path |
| `verified:<spaceId>:<shareId>\|<relPath>` | `{ hash, at, local, mtime, ino }` — `local` is mount-relative for a mirror, absolute for a download; `mtime`+`ino` fingerprint the exact file the hash was proven on (`src/shared/transfer/verified-copy.js`) |
| `src:<spaceId>:<filePath>` | `{ sourcePath, addedAt }` — where a file we own lives |

A claim is a hint and the disk is the truth, re-checked on every listing in the order fixed by `src/shared/transfer/download-claim.js`: file and its folder both gone ⇒ a detached volume, report not-downloaded but **keep** the claim; file gone, folder present ⇒ prune; content hash moved upstream ⇒ prune; outside the space's *pinned* download folder ⇒ not-downloaded, keep (re-pinning restores it). Download roots resolve per-space override → global root → OS downloads (`src/shared/core/paths.js`). A leave clears the claim and `verified:` rows (`cleanupDownloadHistory`); `src:` rows are not cleared.

### 3.4 Pending-transfers bee (`pending-transfers`) — local

`pending-transfers` rows are keyed `<spaceId>:<filePath>`, one per in-flight or interrupted download; field sets are built in `src/shared/transfer/backends/overlay/download-start.js` (`pendingRowFor`) and the channels' `pendingExtra`. `finalPath` is the collision-avoided landing path from which `<finalPath>.mirall.part` and the resume journal derive; `bytesTransferred` lets the UI show `paused-*` / `error` and partial progress without a live transfer. Every write to one row goes through a per-key lock (`createKeyedLock`), including the leave purge, so a progress tick can neither strip an error verdict nor resurrect a row for a left space. Rows clear on completion, cancel/discard and leave.

### 3.5 Participation id and loose-file lifecycle

One id per (member, space, participation): `Hypercore.key(deriveParticipationKeyPair(M, spaceId, driveSuffix).publicKey)` (`src/shared/core/identity-keys.js`). No core backs it. It must stay byte-identical to the key of a Hyperdrive named `space-drive-<spaceId>-<driveSuffix>`, because that is how every existing peer knows the member — a pin test holds it. On the wire it keeps the name `driveKey` (the identity binding signs `noise||driveKey`, §16) and in the profile the row `drive/<spaceId>`. A pending joiner has none, which is how the send path picks `membership:request` over `handshake`. 

#### Loose-file status

`src/shared/transfer/file-listing.js` folds five signals into one row per file: own/peer catalog entries, the claim (re-verified against disk), the pending row, owner presence, and live engine state (pure rules in `src/shared/transfer/transfer-status.js`). Status is always re-derived by `files:list`, never pushed; progress is only `event:decoration`.

| Status | Signals |
|---|---|
| `mine` / `publishing` | own entry with / without a hash (+ active publish) |
| `preparing` | peer entry without a hash |
| `downloaded` / `modified` | verified claim; `modified` = a verified record whose size (mirror: or mtime) no longer matches |
| `downloading` / `verifying` | live engine / `event:decoration` phase |
| `paused-interrupted` / `paused-offline` | pending row, no `errorCode`, owner online / offline |
| `remote` / `unavailable` | peer entry, no pending row, owner online / offline |
| `error` | pending row with `errorCode` |

Rows collapse per content hash by `STATUS_RANK` (`src/shared/transfer/file-dedupe.js`); a hashless row keys on owner + path, so a shared name never merges two owners' files.

#### Publish, share-wait, download

Mechanics are in §4.5, §7.2 and §7.6; these are the data-model invariants.

- **Publish in place** (`src/shared/transfer/backends/overlay/loose-publish.js`): the file stays at its real path; nothing is copied or chunked over IPC. Only admission (name, `MAX_LOOSE_FILES_PER_SPACE`, the `src:` row) holds the space lock, never the hash. A hashless placeholder entry goes out first, so peers render `preparing`.
- **share-wait** `{ profileKey, spaceId, shareId, relPath, cancel? }` is unicast by a member whose fetch hits a null `contentHash`. The owner accepts it only from an authenticated sender connected in that space, and only for its own still-unhashed entry (`src/shared/network/share-wait-intake.js`). It is never persisted or audited; limits are in `src/shared/transfer/share-wait-set.js`.
- **Download** (`src/shared/transfer/backends/overlay/overlay-download.js`): observers see no file or a complete file, never a partial under the real name. The pending row is written before any byte moves. A name counts as taken if the file or its `.mirall.part` exists, so a download never overwrites a user file or adopts another transfer's partial. Pause keeps partial, journal and row; cancel/discard removes all three. The boot sweeps delete only partials and journals that no row references.

### 3.5b Audit-log bee (`audit-log`) — local, never replicated

| Key | Value |
|---|---|
| `evt/<seq, zero-padded to 16>` | record (`SCHEMA_VERSION` in `src/shared/audit/audit-record.js`) |
| `by-space/<spaceId>/<seq padded>` | seq — space filter index |
| `by-device/<seq padded>` | seq — index for rows with no space (device connectivity) |
| `seen/<beeKeyHex>` | version of a peer bee already turned into rows |
| `pstate/<kind\|person\|space\|id>` | `'on'`; absence = off — last recorded peer-subject state |
| `nstate` | last recorded device-connectivity episode; absence = healthy |
| `config` | `{ enabled, retentionDays, maxEntries }` |

Grammar: `src/shared/audit/audit-keys.js`. `seq` is a monotonic local counter, never `Date.now()`, and zero-padded, so one reverse range scan is both the newest-first listing and the pagination cursor, and a clock jump cannot reorder rows. Rows snapshot the names they show, because nothing can be joined at render time: a left space's record is gone and a peer's name needs that peer online. The `search` blob excludes the kind, so stored text stays locale-neutral. Each kind carries an attribution tier (`src/shared/contract/audit-kinds.js`): A first-party, B authenticated peer action, C derived from a peer's replicated bee (authorship proven, time self-reported). No event class scales with file count; a per-kind token bucket collapses overflow into one `audit.suppressed` row.

Retention prunes by age and count at boot and on an interval. Pruning bounds rows, not bytes: `core.clear()` over a pruned range is unsafe because Hyperbee interleaves index nodes with value blocks, and a cleared prefix strands nodes the live tree still points at. `audit:purge` is the one path that reclaims bytes: `truncate(0)` in place, then a store compaction. It writes back `config` and `seen/` and drops `pstate/` and `nstate`. It never recreates the core, because a recreated core returns a stale corestore tracker whose storage is gone and later reads hang (`src/shared/audit/audit-reclaim.js`). The log survives a space leave, a deliberate exception to §6, because a disputed space is when the trail matters.

**Observing peer actions** (`src/shared/audit/peer-records-observer.js` classifies, `src/shared/audit/peer-records-watch.js` writes). A peer's profile bee and catalog are append-only, so "what changed" is `createHistoryStream` from `seen/<bee>`. Three rules keep this correct:
- Baseline at registration, after a head sync. Baselining lazily swallows the first act; baselining before the head arrives turns the peer's existing catalog into a flood of rows.
- Emit only on a durable `on`/`off` flip per subject (`pstate/`), because one act is many puts. A mirror record is re-put on every state change and at the peer's boot.
- Relevance gates: share and file events only for spaces we are in, mirror events only for our own shares. Folder-share catalog rows are excluded, so one mount is one act. Only `__loose__` entries become file rows.

### 3.6 Mounts bee (`mounts-meta`) — local

| Key | Value |
|---|---|
| `owned-folder-mount/<spaceId>/<shareId>` | `{ spaceId, shareId, mountPath, ignore[], createdAt, status, lastError, indexPaused, lastScanCompletedAt? }` |
| `foreign-folder-mount/<spaceId>/<shareId>` | `{ spaceId, shareId, ownerKey, mountPath, enabled, attachedAt, status, lastError, syncedPaths, renamedPaths, initialScanCompletedAt? }` |

Owner: `src/shared/folders/mount-store.js`. Every create, read-modify-write and delete goes through one per-key record writer, so an hours-long pass can never write back a stale whole record over a pause or unmount. An owned mount's `status` is derived from activity, fault and `indexPaused` and set only through `setOwned*`; `patchOwnedMount` refuses it (§7).

### 3.7 Share catalogs, encryption at rest, single-writer

Each member has **one catalog per space** — a replicated, SCK-encrypted Hyperbee holding every file it shares there, folder shares and loose files alike:

| Key | Value |
|---|---|
| `file/<shareId>/<relPath>` | `{ size, mtime, contentHash }` (`contentHash` null while hashing); removal = tombstone `deletedAt` |

Loose files use shareId `__loose__` (`src/shared/transfer/transfer-id.js`). The catalog key is published in the share record (`catalogKeyEnc` + `catalogEpoch`), in `loosecatEnc/` + `loosecatEpoch/`, and in the handshake as `looseCatalogKeyEnc` + `looseCatalogEpoch`; the field-name convention has one owner, `src/shared/shares/catalog-keys.js`. The `…Enc` field name itself tells a reader to decrypt with the SCK of that epoch. A catalog's name derives from the **saved** space record, so its key is published only after the record put — publishing earlier forks a divergent core. A node's `seq` is the re-publish generation marker (`classifyEntryNode`).

Peer catalogs are opened read-only by key, cached, and read in parallel under one interactive budget (`src/shared/shares/peer-catalog.js`, §4.3). No peer drive is ever opened; file bytes travel only through the overlay backend, addressed by content hash (§7.6).

Each member writes only its own logs, so there are no write conflicts and aggregation happens at list time. Loose files are therefore a union with no convergence on a contested path and no cross-peer delete, and third-party removal is not modelled (`src/shared/spaces/membership/fold.js`). Multi-writer work (shared read-write folders, roles, cross-peer delete) is to use **Autobee** (`holepunchto/autobee`), never Autobase; it is not built. Two known constraints: its view is `hyperbee2`, not the `hyperbee` the catalogs use, and it pins one static `encryptionKey` at open, so rotating the SCK inside a view needs a per-version encryption provider.

Status-bearing writes follow the rule in `.claude/lessons.md` (no silent `.catch` on a write that encodes status or intent).

## 4. Networking

### 4.1 Hyperswarm topology

Main's OTA updater runs its own Corestore and a client-only swarm on the upgrade drive (`src/main/updater.js`). The worker runs two swarms over one store and one DHT node:
- **Control** (`src/shared/network/swarm.js`) joins each space's random 32-byte topic. It carries Corestore replication and `mirall/handshake`.
- **Content** (`src/shared/network/content-swarm.js`) joins `hash(topic ‖ 'mirall/content-plane/v1')`. It carries only the overlay channel and authenticates with its own signed `mirall/content-hello`. It has its own Noise identity, so bulk bytes never head-of-line-block control traffic. The derived topic stops each swarm from dialling the other's identity.

A socket that arrives while we hold no topic is destroyed before any handshake code runs.

### 4.2 Protomux handshake

All channels open synchronously before `channel.open()`, because Protomux will not pair a channel opened after the remote's (`src/shared/network/peer-connection.js`). The vocabulary is `src/shared/contract/peer-frames.js`, and routing is `src/shared/network/frame-intake.js`.

| Frame | Fields |
|---|---|
| `handshake` | `profileKey, driveKey` (participation id), `displayName, spaceTopic`, `looseCatalogKey` \| `looseCatalogKeyEnc`+`looseCatalogEpoch`, `creator?`, binding `sig, signerKey, signerNs` |
| `membership:request` | `profileKey, displayName, avatar, spaceTopic, inviteId`, binding. Sent instead of `handshake` while we are pending |
| `leave` / `leave-ack` | `spaceId, profileKey, ts`, binding / `spaceId, profileKey` |
| `presence` | `profileKey, spaceTopic, offline?` |

`membership:grant/deny/cancel` go to `handleMembershipControl` (`src/worker/ipc/membership.js`). The swarm answers `membership:cancel-ack` itself.

**Binding.** `handshake` and `membership:request` must carry a signature by a key that manifest-hashes to `profileKey`, made over this socket's Noise key. The handshake form also covers `driveKey`, with a fallback to the Noise-only form (`src/shared/network/handshake-guard.js`, §16). A captured signature therefore cannot be replayed onto another connection.

**Budgets** (defaults in `src/shared/core/runtime-config-schema.js`). Every frame first passes a 64 KiB size cap and a per-socket budget **before** `JSON.parse`, because parsing is the work being bounded. Identity frames then pay a dual-lane budget. The lane is chosen by a cheap topic lookup, and only a matched frame pays for the ed25519 verify. The matched lane's burst (8 + 3 × topics *this socket* matched) grows with the spaces the peer has proven it shares, not with our own space count. Buckets are keyed by Noise key. A ban destroys the socket, and the firewall refuses the key until the swarm closes.

**Admitting a handshake** (`src/shared/network/handshake-apply.js`):
- Nothing is admitted while we are pending, or on a topic we hold only to replay a leave.
- `admitMember` (`src/shared/network/admission-gates.js`) admits a known or peer-approved member and cross-checks the creator root. Anyone else becomes a converging join request. A tombstoned leaver is ignored.
- `event:member-joined` fires before the persist so the UI unblocks. `members-updated` fires after the persist, and always, because a handshake is a presence arrival.
- A reciprocal handshake goes to a peer new to the space. It also answers a duplicate once `dupReciprocalFloorMs` has passed, because the duplicate means the peer never admitted us.
- A newly joined topic reuses existing sockets and fires no `connection`, so `joinSpaceTopic` sends its handshake on every live socket.

**Leave frame** (`src/shared/network/leave-protocol.js`). It is accepted only if the sender controls `profileKey` on *this* socket, shown by the auth index or by the frame's own binding. The binding survives the teardown race that clears the index, so a third party still cannot evict a member. The handler runs in order:
1. Adopt the leaver's vouchees. If its record is unreadable, apply nothing and let replication retry.
2. Tombstone the leaver.
3. Revoke our vouch.
4. Ack, but only if the tombstone and revoke landed durably.
5. Revoke the leaver's serve grants.
6. Detach the peer from that space. The connection goes only if no shared space remains.

A plain disconnect never prunes membership.

**Replay lanes.** Two frames are re-sent on every new connection, over a re-joined purged topic, until acked:
- an unwitnessed leave, kept as a durable `pendingleave/` marker;
- a withdrawn join request, kept in memory for at most 30 attempts.

### 4.3 Peer catalog caching

Peer catalogs (§3.5) open lazily by key, decrypted with the SCK of the record's epoch. They sit in a refcounted LRU, pinned while read or watched (`src/shared/shares/peer-catalog.js`). One read budget per peer covers head sync and drain. If the head sync spends it, the drain reads with `wait: false`, so an offline owner costs one budget and rows already on disk still surface. Catalog appends drive foreign mirrors (§7.3) and re-drive pending downloads (§4.5).

### 4.4 Disconnect & multi-socket handling

A peer that reconnects on a new socket is re-pointed before the old socket's `close` runs. `handleDisconnect` therefore skips any peer whose `peer.socket !== socket`. On a genuine disconnect it emits `member-left` and `files-updated`, clears the lease and drops the entry. Pending rows stay, and in-flight fetches derive `paused-offline`.

### 4.5 Pause / resume transfers

Recovery is **level-triggered**: reconnects (a handshake or `content-hello`), catalog appends and the convergence tick re-drive durable pending rows. The one exception is a holder that stalls without disconnecting, which produces no level change. For that case the engine retries on its own, with 3 s doubling backoff, and parks after `STALL_RETRY_DRY_LIMIT = 3` attempts that bank no new bytes. While a retry is pending, the paused event still fires with `retrying`. On the folder channel that event is the terminal decoration frame, and the flag only suppresses the loose channel's OS notification.

| Case | Rule |
|---|---|
| Owner offline mid-fetch | Not terminal. The partial and row are kept; status derives `paused-offline` / `paused-interrupted` |
| Owner reconnects | `resumeLooseForOwner` + `resumeFolderForOwner` re-drive that owner's rows. Active, user-paused and still-terminal rows are skipped. The destination is the space's *current* folder |
| Republish | The superseded in-flight hash is cancelled and re-fetched |
| `EHASHMISMATCH` → `TRANSFER_CHECKSUM` | Terminal, because the same holder fails the same way. Only the user's Retry or a republish re-attempts it |
| `TRANSFER_PERMISSION` (errno **and** a refused probe write) | Terminal until the folder accepts a write. The same errno on a writable folder is the retryable `DOWNLOAD_FAILED` |
| Folder missing / disk full, refused by the preflight | Re-driven without a Retry once the preflight would pass |
| Disk full from a write's `ENOSPC` | Waits for Retry, because no free-space reading outranks the write that failed |
| Other error | `DOWNLOAD_FAILED` until Retry |

The terminal set and its clearing rules live in `src/shared/transfer/backends/overlay/fetch-policy.js` and `src/shared/transfer/backends/overlay/download-faults.js`.

**The engine's durable-write policy is deliberately not uniform:**

| Write | On failure | Why |
|---|---|---|
| `recordPending` at start | throws; `start()` fails | without the row, a crash loses the transfer |
| `clearPending` on completion | warn | the downloaded claim decides status; a stale row costs one read |
| `clearPending` on discard | rethrown before anything destructive | a live row whose partial is gone would auto-resume from zero a discarded transfer |
| `recordPendingError` | never throws; the code is held in memory | suppresses auto-resume until restart |

### 4.6 Startup reconnection

Boot order is `src/worker/boot.js`. Three constraints in it are load-bearing:
- Interrupted leaves complete **before** the membership backfill, which would otherwise re-assert `active:true` (§6).
- Member views start **before** the swarm, so the first handshake sees seeded tombstones.
- The relay is applied **after** both swarms exist (§4.8).

After that come topic joins for non-leaving spaces and then the pending-leave replay. The orphan sweeps run last (§14).

### 4.7 Presence & liveness

`connectedPeers` answers "where to send". A **presence lease** answers "who is online" (`src/shared/network/presence-leases.js`). A handshake marks the lease. A 5 s heartbeat refreshes it, and a disconnect or an `offline:true` presence frame clears it. The TTL is 15 s and set by the receiver, so a peer cannot extend its own lease. The TTL catches silently dead sockets, and its expiry re-emits the roster and file hints.

Durable changes reach the renderer as scope-only hints, coalesced into `event:reconcile { scope }` (`src/shared/core/hints.js`, mapped by `POKE_SCOPE` in `src/shared/core/ipc-events.js`). The UI refetches the scope, so a lost hint costs latency, never correctness.

### 4.8 Blind relay

Mirall only chooses which relay key hyperswarm's `relayThrough` supplies, and when. Noise runs end to end over the relayed stream.

- **Slot.** `network.relay` holds `{ publicKey, kind: 'open'|'private', label, enabled, lastTest }`, and `network.relayMode` is `'off'|'auto'|'always'` (default `off`). There is one slot because hyperdht picks among several keys at random, without health checks.
- **Ticket.** A ticket is 69 bytes, z-base-32 encoded to exactly 111 chars behind `mirall://relay/`:
  - byte `[0]` version = 1;
  - bytes `[1..33)` relay key;
  - bytes `[33..65)` member seed;
  - bytes `[65..69)` checksum: the first 4 bytes of the blake2b hash of bytes `[0..65)`.

  The codec is `src/shared/network/relay-ticket.js`, a frozen contract shared with `mirall-relay` and pinned by a shared test vector. The 111-char gate is **not** redundant with the checksum: the last char is 3 slack bits, so a paste missing it decodes to identical bytes. Wire errors are `invalid-format` / `unsupported-version` / `checksum-failed`. The app adds `incomplete-invite`.
- **Identity.** A ticket's seed derives the DHT `defaultKeyPair`, which is the key the relay roster matches. `swarm.js` builds the `hyperdht` node itself because hyperswarm cannot set that key. Open relays use a random per-boot key. Peer identity is unaffected.
- **Seed at rest.** The seed is stored in `relay-ticket.enc` under `safeStorage`, mode `0600` (`src/main/relay-secret.js`). It is a bearer credential: it stays out of `config.json`, is never returned to the renderer, and reaches the worker only on the `bootstrap` frame. `relay:set` (`src/main/relay-slot.js`) is the single writer of vault and slot. A crash between the two writes must leave the *visible* failure, a config naming a missing seed. Today the vault is written first on add as well as on remove, which meets that rule only on remove.
- **Missing identity.** A config naming a private relay does not prove the seed is live. If the seed is missing, `setRelayThrough` (`src/shared/network/relay-install.js`) refuses with `identity-missing` and stays direct, because routing every dial into a roster refusal is worse than no relay.
- **Install.** `setRelayThrough` installs on **both** swarms; on control alone, handshakes connect and transfers stall.
  - `off` installs no function.
  - `auto` relays after a failed punch or on a randomized NAT.
  - `always` relays every dial, best-effort, because the punch underneath can still go direct.
  - `auto` and `always` also offer our key to dialers, except a private relay's: a stranger would get a refusal indistinguishable from an outage.
- **Existing connections keep their path.** The relay is chosen per dial and per inbound handshake. `network:set-relay` (`src/worker/ipc/network.js`) asks `relayMismatch` (`src/shared/contract/relay-apply.js`) whether live connections contradict the new mode. If they do and nothing is transferring, it reconnects, and it replies with `{ mismatch, reconnected }`. A pinned-identity change needs a new DHT node, so `relay:set` reports `identityChanged`, and the renderer restarts the worker via `pear:restartWorker` (`src/renderer/hooks/useRelayApply.ts`).
- **Provenance.** hyperdht discards which relay carries a stream. `src/shared/network/relay-observe.js` wraps `blind-relay`'s `Client.from` and records the relay key per raw stream on `'pair'`. `src/shared/network/relayed-connections.js` classifies each socket once, on both planes:
  - `own` when this side supplied the relay (the pairing initiator), or when the peer named the key we are live on;
  - `adopted` otherwise. Comparing keys alone would call a peer's relay ours whenever both sides configured the same one.

  Only `supplied` connections can be moved by a reconnect. A peer-supplied relay comes straight back on redial, so `off` cannot end it, and Settings names those members instead. An entry drops on `close` or on udx `'remote-changed'`, because hyperdht keeps punching and moves the same socket direct. `members:reach` folds this per person across both planes (`src/shared/network/member-reach.js`).
- **Probe.** `network:test-relay` waits for the `blind-relay` channel to open, not just a Noise connect, so a wrong key fails at configuration time.

---

## 5. Invitation Mechanism

1. `createSpace` draws a random 32-byte topic. The `spaceId` is its first 16 hex chars.
2. `joinSpace` (`src/shared/spaces/space-lifecycle.js`) records a **pending** space. The envelope's `c` becomes a provisional `creatorKey`. Nothing is announced before the grant.
3. The joiner sends `membership:request`. The approver's `membership:grant` carries the SCK and the authenticated creator root. `materializeSpace` then publishes the participation id and loose-catalog key, and from then on the space handshakes normally.

### 5.1 Invite envelope formats

`src/shared/contract/invite-envelope.js` is the only codec. It has no imports and a hand-rolled UTF-8 layer, so the renderer, Bare and main (via `import()`) all decode identically. `decodeInvite` first peels a `mirall://join` link, then tries v0, then v1, else returns `null`. `encodeInvite` emits v1.

- **v0 (compat)** is 64 hex chars (the topic), case-insensitive, with dashes stripped.
- **v1** is unpadded base64url of UTF-8 JSON:

| Key | Meaning | Rule |
|---|---|---|
| `v` | version | `1` |
| `t` | topic | hex64, required |
| `n` | space name | truncated to 80 |
| `o` / `d` | inviter key / name | `d` only with a valid `o` |
| `c` | creator root | hex64 |
| `s` | schema | emitted if ≥ 2; accepted 1–2 |
| `a` | auto-admit | literal `1` |
| `id` | invite id | hex32 |
| `x` | expiry | positive int, ms epoch |

Every field but `t` is an unauthenticated hint. The minting member's invite record and the grant are authoritative.

### 5.2 Deep-link delivery

`mirall://join/<code>` or `mirall://join?code=<code>` launches or focuses Mirall and pre-fills Join (`src/main/deeplink.js`).

| Platform | Hookup |
|---|---|
| macOS | `setAsDefaultProtocolClient`; cold and warm links both arrive via `open-url` |
| Windows / Linux | Cold start: the URL is an argv positional, split off before `paparam` so a strict parse cannot bail (`src/main/boot-argv.js`). Warm start: `requestSingleInstanceLock` + `second-instance` |
| Linux | AppImage: `integrateXdgLinux` rewrites the per-user `.desktop` (`%U`, `x-scheme-handler/mirall`) on each launch. deb: the package owns the entry, and `retireXdgAppImageEntry` removes a shadowing per-user one |

Main buffers links until the preload's subscribe calls `deeplink:flush`. The renderer routes them invalid → expired (60 s grace) → already a member → join (`src/renderer/model/deep-link-route.js`).

**Security.** The topic is a shared secret, so a code lets its holder *knock*, never read. A deep link carries exactly the authority of pasting its code. Read access still needs approval (§16).

---

## 6. Space Leave & Cleanup

`space:leave` (`src/worker/ipc/space-leave.js`) handles a **pending** space with the cancel replay (§4.2), not a teardown. For a materialized space it closes the member view and runs a background teardown, answering the renderer within 12 s. Durable steps come first, and a stall is logged with its phase.

1. Write the **`leaving` marker** (`markSpaceLeavingDurable`). It is the first durable act, so a crash later is completed at boot.
2. Run **`runLeaveTeardown`** (`src/shared/spaces/membership/leave-state.js`). Boot recovery runs the same sequence:
   1. `clearOwnMembership` deletes `member/<S>`. It runs **before** the leave frame, so that co-members who apply the frame can already re-host the delete.
   2. Stop owned mounts, then await `stopPublishingForSpace`. A cancelled publish still writes its revert, and that write must precede the purge.
   3. Tombstone our share ads, so a rejoining co-member cannot read them back.
   4. Unmount foreign mounts.

   The membership delete is a hard gate at boot and best-effort live. The other steps are best-effort.
3. Run the **ack flush** (500 ms floor, 2 s cap). The floor leaves co-members time to pull the `del` block. If any member did not ack, a pending-leave marker is armed.
4. `forgetSpaceRecord`: from here the space is gone, whatever fails later.
5. Cancel our fetches, then revoke **serving** (`revokeServesForSpace` + `bumpServeEpoch`) while the serve index still resolves. As owner we hold no fetch slots, so without this the content plane keeps streaming.
6. Leave the topic and detach the space's peers.
7. Purge history, pending rows, the own catalog, the retired drive, the space row, and unreferenced peer cores (§14). Then start one background `compactStore()`, never awaited.

**Interrupted leave.** The marker survives only an interrupted teardown. At boot, before the backfill, each marked space with members first arms a pending-leave replay, then re-runs `runLeaveTeardown` with durable-only steps. The steps are: the member delete (a throw keeps the marker), then mount records (the restart loops iterate mount stores), share ads, the record, and the space's transfer rows. A `leaving` space is skipped by topic joins, the backfill, `openMemberView`, `slimSpaces` and `space:members`. A rejoin via `joinSpace` clears the marker.

### Membership reconciliation

Membership is **derived**, never patched as a handshake-time cache. `foldMembership` (`src/shared/spaces/membership/fold.js`) is a pure, order-independent OR-Set fold over replicated profile-bee records:

| | Question | Record | Writer |
|---|---|---|---|
| Authorization | in the approval tree rooted at the creator? | `approved/<S>/<joiner>` | the voucher, in its own log; retracted only by deleting the row |
| Liveness | asserts membership? | `member/<S> = { active }` | `p` alone |

A peer is a member only if both hold. Authorization does not depend on the member set, because otherwise a departure would void every vouch its author wrote, and the creator leaving would empty the space. The creator is a permanent, powerless root that is still subject to liveness. A vouch authored after its author's own departure confers nothing; this is judged from log positions, with no clock. Third-party removal is **not modelled**, because it needs an ordered log (Autobee, §3). Discovery uses `.authorized`, not `.members`, so a departed member's approvees are still fetched.

**Local tombstone.** A leaver's `del` may not replicate before it disconnects, and the fold would re-add it. Peers we saw leave go into `lefts` (`src/shared/spaces/member-registry.js`, persisted in `spaces-meta`). The fold subtracts them and the handshake gate ignores them. A tombstone is **never replicated**, because it records our own observation, not a claim about a third party. It self-clears when the leaver writes a newer `member/<S>` (`tombstoneActive`).

**Fold-observed leave.** An approver that was offline during a leave gets no frame. If it kept its vouch, a later re-assert would silently re-admit the leaver. `applyObservedLeaves` therefore mirrors the frame handler for any peer that was in `prior` and now reads `active:false`. That is positive evidence of a leave, which a null, unreplicated or cascade-dropped record is not.
- `prior` is seeded from the durable roster **and** our own approvals, because the roster alone can drop a vouchee on a transient null read.
- Adopting the vouchees and revoking our vouch **gate the tombstone**. If either fails, the surviving vouch re-seeds `prior` next session, so the retry is self-sustaining.
- Serve grants are revoked too.
- `isLeft` prevents a second action after a leave frame.

**Capture and convergence.** Every followed roster bee is captured into a local snapshot (`makeCaptureScheduler`, `src/shared/spaces/peer-bee.js`), because a starved follow's range download never completes. Captures are refcounted across spaces. Replicas converge once the leaver's `member/<S>` reaches them, from anyone. One gap remains (§14): while the leaver is offline and its record has reached no one we connect to, the departed member stays in the roster.

## 7. Folder Sharing (Owned & Foreign Folders)

### 7.1 Concepts

A share is two things. One is a record in the owner's profile bee at `share/<spaceId>/<shareId>` (`src/shared/shares/shares.js`): id, immutable `name`, `displayName?`, owner, `contentMode`, catalog key. The other is a `file/<shareId>/<relPath>` section of the owner's replicated catalog (§3.7). No bytes go into any drive (§7.6). Loose files are the `LOOSE_SHARE_ID` section of the same catalog.

| Term | Meaning |
|---|---|
| **Owned folder / owned mount** | The owner's local `mountPath` for a share. A chokidar watcher in Electron main keeps the catalog in step with it. Persisted locally at `owned-folder-mount/<spaceId>/<shareId>` (`src/shared/folders/mount-store.js`) |
| **Foreign folder / mirror** | A consumer's local path that receives a read-only, continuously materialized copy. Persisted at `foreign-folder-mount/<spaceId>/<shareId>` |
| **Drive path** | The consumer-side row key `/<name>/<relPath>` (`src/shared/shares/share-listing.js`). It keys download claims, pending transfers and reveal targets on every member, so **`name` is never rewritten**: a rename sets `displayName` |

Mount statuses and their transitions are documented in the header of `src/shared/contract/statuses.js`. The owned tuple is the foreign one minus `idle`. An owned mount's status is derived by `src/shared/contract/mount-precedence.js` from its `indexPaused` and `lastError`; a mirror's status is assigned.

### 7.2 Publishing (owner side)

**One queue, many producers.** Mount, relocate, boot, the watcher, the catch-up, the periodic reconcile and a loose-file add all only *enqueue*. `src/shared/folders/publish-service.js` executes, and hands each item to the channel its share id selects: `folder` (`src/shared/folders/owned-channel.js`) or `loose` (`src/shared/transfer/backends/overlay/loose-publish.js`). The rules:

- **An item is keyed by path (`shareId\0relPath`), never by hash.** At most one item per path is live. A second request folds into the queued item, or marks a running one for exactly one rerun, so a file is never read twice concurrently.
- **Queues are per space and the scheduler is fair across spaces.** The rules are in the header of `src/shared/folders/publish-scheduler.js`: bulk slots (`publishConcurrency`) go round-robin, no space holds every slot while another has work, and one express lane lets an interactive watcher event start while every bulk slot is held by a long hash. Within a space, retires go before publishes, and `publishOrder` (runtime config) orders the bulk work.
- **Bulk items write through one catalog batch per space**, so a consumer sees few atomic heads. An interactive item first flushes the batch and then writes direct, so a dropped-in file shows up at once and no staged op can land after it and undo it.
- **Every executor re-derives its precondition from current state.** It re-resolves the mount (a relocate makes enqueue-time paths stale). It refuses to act while the root is missing, because a vanished root makes chokidar emit one `unlink` per file. A retire confirms the file is gone **under exactly that name** (`src/shared/folders/disk-presence.js`), because a following stat would call a case-only rename "present" forever. Absence from an older snapshot only makes a file a candidate for deletion.

**Change detection is size+mtime and stat-only.** The content hash is published so mirrors can verify against it; it does not drive owner-side detection. `DEFAULT_IGNORE` (`src/shared/folders/path-keys.js`) excludes only OS litter and our own `*.mirall.part` files. The rest of the folder publishes, repository and dependency directories included.

**Watcher gaps.** `src/shared/folders/echo-guard.js` drops events for paths the worker itself just wrote, so our own downloads are not re-uploaded. macOS fsevents coalescing drops adds, so after the watcher goes quiet a debounced catch-up diff runs (`src/shared/folders/owned-watcher.js`). It leaves a file still being written to `awaitWriteFinish`, and re-arms with backoff while it deferred anything. A periodic stat-only reconcile (6 h, `src/worker/mounts-runtime.js`) heals sleep and dropped events. Every `deepReconcileEvery`-th pass content-hashes everything, to catch an in-place rewrite that kept size+mtime. **Relocate** always runs deep, so that a moved tree (identical content, new mtimes) re-uploads nothing.

**Delete** stops the watcher and the reconcile, deletes the mount record, and tombstones the share record. Consumers act on that tombstone, and it cascades to every mirror. The two writes go to different bees, so an `owned-delete` durable intent brackets them (`src/shared/folders/folder-intents.js`, §2). The per-file catalog entries are **not** tombstoned. The overlay needs only the share tombstone, but the deleted share's metadata stays in the owner's catalog for the life of the space (§14).

### 7.3 Mirroring (consumer side)

The mirror loop (`src/shared/folders/mirror-pass.js`) ticks every 30 s and again when the owner's catalog appends. It fetches changed entries by hash through the overlay (§7.6). A converged tick skips the walk while the owner's catalog version is unchanged. That version cannot see a **local** edit, so main also watches every enabled mirror (`src/shared/folders/mirror-watcher.js`) and requests a walk for anything but the mirror's own landings. The walk keeps a foreign edit as a `(conflicted copy)` sibling and restores the owner's bytes. `startForeignLoop` / `stopForeignLoop` (`src/shared/folders/foreign-verbs.js`) are the only verbs that make a mirror live or not live.

**Ownership of paths.** A mirror may delete only paths in `syncedPaths`, the set of paths it delivered, so a user's pre-existing file is never removed. On a name collision the user's file gets a sibling. A path is claimed before its bytes land. The record is written through a read-merge patch, so it cannot clobber a concurrent pause or resurrect an unmounted record.

**Deletion safety** (`shouldHonorDeletions`, `src/shared/folders/path-keys.js`). Owner-side deletions are honoured only when all three of these hold:

- the owner is online, so the listing is live and not a replica snapshot;
- the listing is non-empty, because an empty listing is a replication gap;
- the listing was read to completion, because a drain that timed out returns a partial list that looks exactly like a deletion, and the risk grows with the folder's size.

Past those gates a magnitude cap applies. Up to `minMirrorDeletions` deletions pass. Above that, a pass may remove at most `maxMirrorDeletionRatio` of what the mirror owns, and ties keep the files.

A failed file retries under a per-(path, hash) attempt budget (`src/shared/folders/mirror-budgets.js`). The budget is bounded rather than a permanent block, so a second healthy holder still gets its turn. Unmount stops the loop and removes the record. It tombstones the mirror row but leaves the files on disk.

### 7.4 Mount validation

`src/shared/folders/mount-validate.js` checks every mount path, owned or foreign. It **refuses**:

- system roots, the app's storage dir, personal roots (home, Desktop…), cloud-sync roots, Windows reserved names, and non-writable paths;
- an overlap with **any** existing mount, except two owned folders at the exact same path;
- nesting with **any** download root, in either direction. Downloads inside an owned folder would be republished, and mirrors mixed with downloads are indistinguishable. The download-folder validator runs the reverse check.

It also returns non-blocking advisories: macOS TCC-gated folders, and possibly removable Windows drives. The path math (`src/shared/folders/path-keys.js`) is pure and has no `bare-*` imports, so it unit-tests under Node.

### 7.5 Mount lifecycle & the probe loop

`MountsRuntime` (`src/worker/mounts-runtime.js`, §2 boot step 9) resumes both mount kinds from `mounts-meta` and arms a 60 s probe over every mount path and download root. A missing path flips the share to `mount-point-gone` and stops its watcher or loop. A returning path restarts it. A returning *owned* path goes back to `scanning` (a paused index stays paused), and the scan's outcome, not the probe, writes the next status.

The probe acts on **transitions**, against a baseline reconciled with the durable record. A record reading `mount-point-gone` over a path that is back counts as an edge, whoever wrote it, and that is what makes "source missing" clearable. `owned-folder:list-all` stamps a live `mountPointMissing` that the renderer ranks first, so the strip *appears* off any read, but clearing it needs a mount-status poke. Every writer that notices an absent root records it through `handleOwnedMountGone`.

### 7.6 Content backend (`overlay`)

All shares move bytes through `src/shared/transfer/backends/overlay/`. The canonical bytes are the user's **real file on disk**, never a Hyperdrive blob store.

- **Publish** streams the file once and computes the whole-file hash and the content-addressed chunk map in the same pass. Its metadata goes into the SCK-encrypted catalog (§3.7).
- **Fetch** requests a file *by content hash* from any online holder over the `hyper-overlay/v2` Protomux channel, and verifies chunks against the chunk map as they arrive. The file lands as a visible `<name>.mirall.part` and is atomically renamed, so observers see only a missing or a complete file. Serving passes the §16 authorization gates, and **a denial looks the same as "I don't hold it"**.
- **Resume**: an app-private receive journal (chunk bitmap + streaming-hash snapshot, in `journals/`) lets an interrupted download continue without re-verifying from scratch.

`getContentBackend(share)` (`src/shared/transfer/content-backends.js`) returns the overlay for `contentMode === 'overlay'` and `UNSUPPORTED` for every other mode. Callers render `UNSUPPORTED` as unavailable, never as a route; `test/integration/content-backend-conformance.test.js` locks this.

**Channel versioning.** The channel handshake announces `{version, capabilities}`. A peer that sends nothing is version 1 with no capabilities, so a capability-gated behaviour is simply off against it. The decoder must be **total**: any channel dying takes the whole socket, and the channel id is public, so a decoder that could throw gives any swarm peer a one-frame socket kill. Raise `MIN_VERSION` (`src/shared/transfer/backends/overlay/vendor/protocol-v2.js`) only in the change that drops a message slot or changes a codec. A peer below it loses only its content channel. The control channel (`mirall/handshake`, or `mirall/content-hello` with the separate content plane) and Corestore replication stay up. New wire messages are appended last, so older peers ignore them.

**Vendor boundary.** The serve/fetch engine in `vendor/` is a subset of `hyper-overlay`, and `src/shared/transfer/backends/overlay/vendor/PROVENANCE.md` records every local change. Mirall policy (authorization, catalogs, lifecycle, limiters, caches) stays outside `vendor/` and is **injected** from `src/shared/transfer/backends/overlay/overlay-instance.js`.

**Bandwidth caps** (`src/shared/transfer/bandwidth-limiter.js`; its header has the mechanics):

- Caps govern the **content plane only**. Throttling replication, handshakes or DHT traffic would starve convergence (`test/flow/content-plane-hol.test.js`).
- A corrupt cap, or a getter that throws, fails **open** (unlimited).
- Each consumer holds its own `stream()` handle.
- Fairness is measured in bytes, not turns, because chunk sizes differ up to 64× across tiers.
- Upload is charged before each send: a `take()` of 0 means don't send, and the serve grant is re-checked after the wait.
- Download is paced by pacing chunk requests.

**Liveness.** The downloader's 30 s no-progress watchdog runs only while something is outstanding with that peer. It is extended in two ways, both bounded by 30 min since the last *verified* progress:

- a holder parked on its own upload cap sends **keep-alive** frames;
- the watchdog asks the transport whether bytes are still arriving (udx packets, because one 4 MB chunk is a single secret-stream frame).

Decoded chunk maps are cached on the serve side (`src/shared/transfer/chunk-map-cache.js`). A write invalidates the entry, and a fence stops an in-flight decode from caching a stale value.

---

## 8. IPC Protocol

### Renderer ↔ Main (`window.bridge`)

`src/preload/preload.js` is the renderer's entire native surface, and the list of methods lives there. The rules:

- Only `pkg`, `isDev`, `getLocale` and `getConfig` are synchronous. Each is read once at first render, where a promise would paint the wrong locale or theme first. Every new method is async.
- Every subscription returns its own unsubscribe.
- `startWorker` / `restartWorker` accept only the specifiers in the worker-entrypoint allowlist, and main enforces the same list.
- **Main is the sole writer of `config.json`.** The renderer caches the snapshot (`src/renderer/platform/config-client.ts`). Settings that the worker also needs, such as bandwidth caps and the download folder, are written to main first. The renderer then forwards the stored value to the worker (`settings:set-bandwidth`, `settings:set-download-folder`).
- `showInFolder({ host, path })` is an authorization check (`src/main/notifications.js`). Anything but `host: 'client'` is refused. The path is resolved *before* the containment test and must lie under the home dir or a download root the worker published.

### Renderer ↔ Worker (NDJSON)

Newline-delimited JSON over the worker's stdio pipe, relayed by main. The vocabulary is the contract:

| File | Owns |
|---|---|
| `src/shared/contract/requests.js` | Every request row: name, `kind` (`query` = read-only, retry-safe; `command` = may mutate), `args` (drives the router's validator), and optional `deadlineMs` |
| `src/shared/contract/responses.ts` | The response type per request |
| `src/shared/contract/events.js` | Every event name, `TARGETED_EVENTS`, `isEphemeralEvent` |
| `src/shared/contract/ipc-frames.js` | The non-request frames: `hello`/`hello-ack`, `bootstrap`, `response`, `cancel`, `CLIENT_KINDS`, `TRUST`, and `IPC_PROTOCOL_VERSION` (the wire's own version, bumped by hand in the change that alters a frame) |

The rules for adding to the contract:

- **A field is required unless the handler defines what its absence means** (see the `requests.js` header).
- `kind` decides deadline enforcement (`src/shared/contract/request-deadlines.js`). A query's worker deadline (default 30 s) *aborts*. A command's deadline only *warns*, because aborting mid-write makes the half-states that durable intents exist to prevent. `deadlineMs: 0` means deliberately unbounded, for uploads, previews, exports and `share:read-file`. The renderer's own give-up timeout (`src/renderer/ipc/ipc.ts`) is a separate bound. A caller that gives up sends `cancel`, which is a control frame so it is not queued behind the request it cancels.
- `test/unit/event-taxonomy.test.js` checks that the emit sites, the renderer subscriptions and `events.js` name the same set of events.

**Connection and replay.** A client sends `hello` (wire version, kind, cursor) and nothing else is honoured until `hello-ack`. A version outside `IPC_PROTOCOL_MIN_SUPPORTED` is refused (`src/shared/contract/hello.js`). Each event carries a `seq` within a per-process `epoch` (`src/shared/contract/event-cursor.js`). A reconnecting client resumes through `events:resume`, or learns it must resync, and `event:worker-ready { epoch, head }` tells a client where the stream stands. Ephemeral events (`event:decoration`, `event:awareness`, `*-progress`) are numbered but never replayed. Targeted events (the preview progress events) go only to the client whose operation they belong to.

**Event semantics.**

- **State pokes are not status.** Named `*-updated` / mount-status pokes are mapped to a `Scope` by `POKE_SCOPE` (`src/shared/core/ipc-events.js`) and fanned out as `event:reconcile { scope }`, a coalesced, level-triggered hint to refetch (§4.7). Both mount-status events map to the *shares* scope.
- `event:decoration` is the **one** per-file progress channel, used for download and for owner-side publish/prepare (`phase`). Folder rows key by `shareDecoKey` (`src/shared/contract/decoration-key.js`) and loose rows by drive path. An entry is cleared only by a terminal `done`.
- `event:awareness` ("who is downloading from me") is TTL soft-state. It is never persisted and never a status source.
- `event:transfer-*` are notification signals. Status is always re-derived from `files:list` / `share:list-files`, and `transfer-paused.reason` is toast wording only.

**Request semantics a caller would not guess.**

- `space:members` is the only payload that carries avatars; `spaces:list` rosters are slim.
- `network:reconnect` ends the live connections, because a connected peer is never re-dialled.
- A partial `audit:list` page with a non-null cursor is normal, because the scan is budgeted.
- `shutdown` is host-only and is answered before teardown begins.
- Main's chokidar events reach the worker as the `event:*-fs-event` request rows.

### React integration (`src/renderer/store/`)

There are two stores. Each is plain JS with an injected transport, so it tests under brittle-node, and each is bound to React through `useSyncExternalStore` rather than a `useState` mirror, which could disagree with the store.

- **`query-store.js`** (the worker contract, via `useQuery(type, params, scopes, { enabled, coalesceMs })`). It has one entry per `[type, sorted params]` and owns fetching, dedup, caching and scope invalidation. An invalidation bumps `seq`, aborts the read in flight (`cancel`), keeps the cached value, and refetches only subscribed entries. The store does **not** interpret responses. The never-blank merge and the terminal-vs-transient error policy are per-view decisions and stay in the hooks. `enabled: false` means the ids are not ready: the hook neither fetches nor subscribes. An entry keeps the scopes it was first registered with.
- **`main-store.js`** (Electron main facts, catalogued in `main-queries.js`, via `useMainQuery`). It is deliberately separate. `useQuery` is typed to the worker's `RequestName`, and a main fact changes only when this app writes it or main pushes it, neither of which is a reconcile hint. It has no abort (`invoke` cannot cancel) but keeps `seq`, because a write or a push can land mid-read.

The per-hook contract lives in `src/renderer/hooks/README.md`: `loading` means *cold*, hooks re-derive through scopes rather than event subscriptions, and props given to memoized rows must be identity-stable. Every hook that does not use the store says why in its header.

### Developer console

`src/renderer/platform/dev-console.ts` installs `window.mirall` in **every build, production included**. It offers read-only worker diagnostics plus `verbose()`, which flips worker and main logging live, and `update()` / `version()` / `identity()` over the bridge. `mirall.help()` lists the commands.

---

## 9. Update System

OTA runs on `pear-runtime`'s updater (`pear-runtime-updater`), wrapped by `src/main/updater.js`. It watches the release channel's Hyperdrive, named by `package.json#upgrade`. The source tree has no `upgrade` key; the release build bakes it in (→ `build-process.md`). OTA is **off** when the key is absent, under `--no-updates`, and on a `.deb` install, which updates through the package manager (`src/main/install-kind.js`). The runtime is constructed lazily, because building it opens drives and joins a swarm.

When the drive's `/package.json` version is greater than the running one, the updater mirrors this platform's bundle into `pear-runtime/next/<length>.<fork>` and emits `updating` and then `updated`. Main forwards both as `pear:event:updating` / `pear:event:updated` (`src/main/window.js`). At an *equal* version it only prefetches. The installed build must therefore equal the staged drive version, or the banner loops on every launch (→ `build-process.md`).

**Banner.** `src/renderer/platform/updates.ts` reacts to `updated`. A dev build reloads. A packaged build reads the staged version from **main** (`bridge.appVersion()`), because the worker's bootstrap fork/length can still be a stale `0/0`. The banner is passive ("applied on next start" plus Dismiss). There is no in-app relaunch.

**Apply — no user action**, with timing per platform:

| Platform | When | Why |
|---|---|---|
| Windows | Pre-staged the moment `updated` fires | `msix-manager.addPackage` takes seconds, and inside `before-quit` it races the relaunch and fails silently while the `.msix` is locked. `bundled: app.isPackaged` is passed explicitly, or the updater stays dormant (there is no app path on Windows) |
| Linux | Pre-staged on `updated` | So the staged AppImage does not wait for a clean quit |
| macOS | At quit only | A mid-session `fsx.swap` would let a later disk read mix new files with old in-memory code |

On every platform the quit sequence (`src/main/lifecycle.js`) promotes a staged-but-unapplied bundle: `preventDefault()`, await the apply, re-`quit()`. It works this way because Electron does not await async listeners.

`src/main/updater.js` wraps the library's `_update` and `applyUpdate`:

- `process.noAsar` is scoped to those calls. Electron would otherwise open the half-written `app.asar` in the mirror as an archive, and the flag cannot be set globally because our own requires need the shim.
- The staged AppImage is `chmod 0o755`'d before the swap, because `localdrive` sets the executable bit only when the drive entry carries it.
- Apply failures are recorded to `pear-runtime/last-apply-error.json` (`src/main/apply-error.js`) and cleared on the next success.

## 10. UI Structure

Visual language (tokens, typography, component styling, motion, platform chrome) lives in `design.md` and is authoritative. This section covers structure and behaviour only. `src/renderer/platform/platform.ts` stamps `data-platform` on `<html>`. Window bounds persist through `src/renderer/platform/window-bounds.ts` → `bridge.get/setWindowBounds`.

### Internationalization

`src/renderer/platform/i18n.ts` sets up i18next with five locales (`en`, `de`, `fr`, `es`, `it`). Catalogs at `src/renderer/locales/<code>/{common,errors}.json` are **statically imported**, so esbuild bundles them and nothing is fetched at runtime. The language resolves as: persisted pref (`config-client.ts`, hydrated synchronously from `bridge.getConfig()`) → the primary subtag of `bridge.getLocale()` → `en`. `setLocale` persists the choice, switches i18next, updates `<html lang>` and re-labels the tray. To add a locale: add the two JSON files, a `SUPPORTED_LANGUAGES` entry and the imports in `i18n.ts`.

**German UI uses the generic masculine.** Never propose `Kolleg:innen`-style forms.

### Screens and routing

`app.tsx` renders `WorkerFaultScreen` or `OnboardingScreen` (no profile yet) *before* the router. Everything else goes through `src/renderer/ScreenRouter.tsx`, whose `switch` ends in a `never` assignment: a screen added to `src/renderer/shell/navigation.ts` without a case fails to compile.

- **Spaces** (the default; swapped for **ConnectionProblem** while the connection gate is up) → **Space View** → **Folder View** (one share).
- **Account**: profile edit, network status, Activity Log, app version, Feedback.
- **Settings** hub → General / Appearance / Notifications / Network / Storage / Activity Log settings.
- **Network status** → Diagnostics / Advanced. Both children always back out to Network status, never to where status was opened from.

The Folder View route reads its share from the live listing and is **keyed by `share.id`**. A re-target without the key merges one folder's rows into the next folder's listing, and a share deleted underneath the route makes it go back. Root dialogs (`components/modals/AppDialogs.tsx`: Feedback, What's New, Create, Join) show one at a time by construction, so a deep link replaces an open dialog rather than stacking behind it.

### Toasts vs OS notifications

These are two deliberately separate systems. **Toasts** (`src/renderer/components/toast/`) give foreground feedback on something the user just did. **OS notifications** (`bridge.notify` → `src/main/notifications.js`, dispatched by `src/renderer/notifications/dispatcher.ts`) report background events the user may not be watching. New error-surfacing code defaults to toasts. Renderer actions report failures through `useRunAction` inside `ToastProvider`, or through `InlineError` outside it.

`ToastProvider` is the outermost provider in `app.tsx`, so modals can raise toasts. The stack rules (`toastStack.js`):

- Same `id` replaces in place.
- At most 4 are visible. Past the cap, the oldest auto-dismissing toast that is not hovered or focused is evicted.
- A sticky toast (`duration: 0`) is never evicted, so the stack can grow past the cap.
- Timers pause on hover and focus.

`toast/bridges/*` turn worker, connectivity, download-folder and join-request state into toasts. In dev builds (`bridge.isDev()`), the API is exposed as `window.__toast`. Packaged builds never expose it.

### Component behaviour worth knowing

Browse the inventory with `ls src/renderer/components`; styling is in `design.md`.

- `UpdateBanner` publishes its height as `--banner-h`, which every screen subtracts, so a banner pushes screens down rather than covering them.
- `IconButton` requires `ariaLabel`. `ActionMenu` has three trigger variants: `primary` (the screen's key action), `subtle` (the icon-only three-dot) and `neutral` (several menus side by side).
- Adding a folder share is **one worker command** (`share:create-and-mount`, via `createShareThenMount` in `src/renderer/hooks/useFolderMount.ts`), with a durable intent across both writes. There is no renderer-side rollback to keep in sync.
- `ScanPreviewModal` is the shared preview step for add-folder, mirror and relocate.
- `FilePath` middle-truncates every filesystem path through `splitPathForDisplay()` (`src/renderer/model/share-paths.js`).
- Folder-vs-files drop classification is in `src/renderer/model/drag-share.js`: `webkitGetAsEntry()` is null during `dragover`, so a single typeless item is treated as a folder.

---

## 11. Module Structure

One row per source file, named by its full backticked path. `test/invariants/arch-doc-module-table.test.js` holds this section to the tree: every `.js`/`.ts`/`.tsx` under `src/shared`, `src/main`, `src/preload` and `src/worker` (minus `vendor/`, `locales/`, `.d.ts`) needs a row, and every `src/…` path named here must exist. The renderer keeps directory-level rows.

### Repository

| Path | Purpose |
|---|---|
| `src/main/`, `src/preload/` | Electron host process (CommonJS) and its contextBridge |
| `src/worker/` | Bare worker: entry, composition root, IPC handler modules |
| `src/shared/` | The worker's data layer, by domain (ESM, `src/shared/package.json` marks it). Main reaches into it only by `require`/`import()` of single modules, mostly `contract/` |
| `src/renderer/` | Renderer source (TS + React → `assets/dist/`) |
| `assets/` | Shipped renderer assets: `index.html`, `fonts/`, `theme-bootstrap.js` (pre-paint theme), build output in `dist/` |
| `resources/` | Per-platform build assets: `darwin/`, `win32/`, `linux/`, `tray/`, `brand/` (source SVGs) |
| `forge.config.js` | electron-forge config: makers, the `afterCopy` hook that injects `UPGRADE_KEY`, the Linux licence stamp, MSIX version patching |
| `scripts/` | `build/` (AppImage, icon generation), `ci/` (gate scripts), `install/` (Windows/Linux install + uninstall), plus top-level dev tools (`inspect-store.mjs` — quit Mirall first; `bench-*.mjs`; `export-translations.mjs`). MSIX signing is out-of-band (→ `build-process.md`) |
| `test/` | Test suite, a CI gate (§15) |
| `eslint.config.mjs`, `eslint-rules/` | Flat config (incl. `jsx-a11y`, a build gate); `eslint-rules/invariants.mjs` holds the invariant tables (pure-module lists, single-owner rules) that guard tests read back |
| `tailwind.config.js` | Design tokens + content globs |
| `tsconfig.json` | Typecheck only (esbuild bundles): `src/renderer`, `src/shared/contract`, `test/typecheck` |
| `tsconfig.worker.json` | Typecheck only, `lib: ES2022`, `checkJs: false`: reports only `// @ts-check` files — every `src/worker/ipc/` module and `test/typecheck/worker/`. `src/worker/global.d.ts` declares Bare's timer globals |

### `src/main/` + `src/preload/`

CommonJS. `src/main/watch-host.js` is the only module allowed to load chokidar (lint rule).

| File | Purpose |
|---|---|
| `src/main/main.js` | Entry/wiring: argv + `userData` redirect, config/identity/diagnostics IPC, deep-link dispatch + single-instance lock, KEK boot, quit wiring |
| `src/preload/preload.js` | `window.bridge` — the renderer's entire native surface; the only file touching both Electron and the renderer window |
| `src/main/asar-spawn.js` | `spawn` asar→`app.asar.unpacked` fix; must install before any module that can load bare-sidecar |
| `src/main/app-protocol.js` | `app://` scheme + boot warm-up of every asar-internal read (must precede the updater's noAsar window) |
| `src/main/apply-error.js` | OTA apply-failure journal (`last-apply-error.json`) for the diagnostics bundle |
| `src/main/boot-argv.js` | paparam argv parse: splits off `mirall://` links, downgrades a bail to a warning |
| `src/main/config-store.js` | Single owner/writer of `config.json`: debounced atomic writes, defaults, legacy-file fold |
| `src/main/debug-gate.js` | The live `debug` / `verbose` logging gate |
| `src/main/deeplink.js` | `parseDeepLink` — validates `mirall://join/<code>` against the invite envelope |
| `src/main/dir-tripwire.js` | DIAGNOSTIC: refuses + logs `fs` calls that would destroy the profile dir; rule duplicated from `src/shared/core/dir-tripwire.js`, a unit test pins both |
| `src/main/env-json.js` | `envJson` — JSON-valued env overrides; malformed values ignored, never echoed |
| `src/main/feature-flags.js` | `feature-flags.json` read once at boot and cached (lazy reads race noAsar) |
| `src/main/folder-watchers.js` | Recursive watch roots per owned share / mirror over the watch host |
| `src/main/loose-file-watchers.js` | Watched individual loose-file paths; path → spaces fan-out |
| `src/main/watch-host.js` | Sole chokidar owner: native + polling instances, network-path routing, error-storm guard |
| `src/main/identity-kek.js` | Identity KEK at rest under `safeStorage` (`kek.enc`); worker receives the KEK, never M |
| `src/main/relay-secret.js` | Private-relay member seed at rest (`relay-ticket.enc`, `safeStorage`) |
| `src/main/relay-keys.js` | Relay-slot validation (key decode, mode, sanitize) for `config-store` |
| `src/main/relay-slot.js` | `relay:parse` / `relay:set` IPC — the one relay this node offers |
| `src/main/install-kind.js` | Linux install kind (`appimage`/`deb`/`unpacked`/`none`) + why OTA is off. Pure |
| `src/main/ipc-frame.js` | Worker-pipe byte splitter; only small `main-request` frames are parsed on main's thread |
| `src/main/main-requests.js` | Worker→main command router keyed off `contract/main-requests.js`; `dispatch` never rejects |
| `src/main/worker-bus-failure.js` | The one failure-reporting policy for the worker bus |
| `src/main/worker-entrypoints.js` | Worker spawn allowlist, resolved before the noAsar window |
| `src/main/worker-host.js` | Spawns the Bare worker; the one path that writes its pipe (hello, bootstrap, watcher events); exit reaper |
| `src/main/lifecycle.js` | The ordered, run-once quit sequence and the worker-restart steps |
| `src/main/quit-state.js` | `isQuitting` / `markQuitting` — shared quit flag |
| `src/main/log-ring.js` | Bounded in-memory log ring for the diagnostics bundle; never written to disk |
| `src/main/logging.js` | `sendToAll` broadcast + main-console forwarding into the log ring; installed first |
| `src/main/net-online.js` | Polls Chromium `net.online`; may only declare offline, never healthy |
| `src/main/notifications.js` | `notify:*` IPC over native `Notification` + the `shell:showInFolder` allowlist |
| `src/main/updater.js` | Lazily built embedded pear-runtime and the OTA IPC surface |
| `src/main/settings-ipc.js` | Download folder, bandwidth caps, general prefs, dir pickers, login-item/XDG autostart |
| `src/main/prefs.js` | The general-preferences record behind accessors (no stale copies) |
| `src/main/window.js` | BrowserWindow + its persisted zoom, bounds and theme |
| `src/main/window-bounds.js` | Off-screen restored-bounds guard. Pure |
| `src/main/window-shortcuts.js` | Classifies `before-input-event` → DevTools / zoom / nothing. Pure |
| `src/main/menu.js` | Application-menu template. Pure |
| `src/main/menus.js` | Tray + app menu, rebuilt (never mutated) on change |
| `src/main/xdg-integration.js` | Linux AppImage `.desktop`/icon integration and its removal on a deb install |

### `src/worker/`

ESM under Bare (`src/worker/package.json`). Every `src/worker/ipc/` module opens with `// @ts-check` (test-enforced).

| File | Purpose |
|---|---|
| `src/worker/main.js` | Entry: crash backstop, pipe + close hooks, bootstrap frame, handler registration, shutdown deadline, `Bare.exit` |
| `src/worker/boot.js` | Composition root: `bootDurable` + runtime tier, started in order, closed in reverse; never exits the process |
| `src/worker/connection-lifecycle.js` | What a closed pipe means: detach the client, then decide stay / linger / stop |
| `src/worker/dir-tripwire.js` | DIAGNOSTIC: the tripwire over `bare-fs`, armed from the bootstrap storage path |
| `src/worker/mounts-runtime.js` | `MountsRuntime`: mount resume, durable status writer, per-share reconcile timers, mount/download-root probe |
| `src/worker/owned-mount.js` | `createOwnedMounter` — shared by mount and create-and-mount so they cannot drift |
| `src/worker/sweeps.js` | `Sweeps`: periodic missed-event backstops (presence, invite expiry, index compaction, audit prune) |
| `src/worker/space-projection.js` | Slim (`spaces:list`) vs full-roster space projections |
| `src/worker/audit-refs.js` | Audit-row name snapshots resolved from live worker state |
| `src/worker/ipc/audit.js` | Activity Log read/config/purge handlers |
| `src/worker/ipc/diagnostics.js` | `diagnostics:export` support bundle; reads the boot root via a getter (it is reassigned) |
| `src/worker/ipc/feedback.js` | `feedback:send` |
| `src/worker/ipc/files.js` | Loose-file list/add/remove/reveal and download controls (routed by transfer-id shape) |
| `src/worker/ipc/folder-preview.js` | Owned + foreign pre-mount scan previews and their cancel (one abort registry) |
| `src/worker/ipc/foreign-folders.js` | Mirror-mount handlers; removal runs under an intent |
| `src/worker/ipc/owned-folders.js` | Owned-folder handlers + watcher events relayed from main |
| `src/worker/ipc/shares.js` | Share records and reads; create split into refuse/replicate halves around an intent |
| `src/worker/ipc/spaces.js` | Space create/join/invite/update and per-space reads |
| `src/worker/ipc/space-leave.js` | `space:leave`; teardown order shared with boot via `spaces/membership/leave-state.js` |
| `src/worker/ipc/membership.js` | `createMembership`: knock peer-frame handlers, member registry, approve/deny; built before the root |
| `src/worker/ipc/network.js` | Swarm status, reconnect, relay config, canary, liveness |
| `src/worker/ipc/profile.js` | Local profile read/write |
| `src/worker/ipc/settings.js` | Storage info, bandwidth, global download folder, verbose |
| `src/worker/ipc/worker-process.js` | `shutdown` (host only), `ping`, `events:resume` |

### `src/shared/core/`

Infrastructure with no domain knowledge. May not import `folders/` (shared path rules live in `contract/paths.js`).

| File | Purpose |
|---|---|
| `src/shared/core/runtime-config.js` | Live runtime config: `setRuntimeConfig`, live setters, validated getters |
| `src/shared/core/runtime-config-schema.js` | Every config key, default and rule; `buildConfig` |
| `src/shared/core/runtime-config-rules.js` | The validation rules getters apply; never throw |
| `src/shared/core/ipc.js` | Worker IPC router `createIPC`: pre-start queue, cancel, metrics/failure counters |
| `src/shared/core/ipc-events.js` | Event plane: poke→reconcile fan-out, seq numbers, broadcast vs targeted, resume |
| `src/shared/core/ipc-handshake.js` | `hello` / `hello-ack` + bootstrap exchange gating all other frames |
| `src/shared/core/ipc-client.js` | One connected client (pipe, in-flight requests, trust) + the registry |
| `src/shared/core/ipc-dispatch.js` | One request frame: validation, cancellation token, metrics, failure log |
| `src/shared/core/ipc-deadlines.js` | In-flight ages + per-kind deadline sweep driven by the health tick |
| `src/shared/core/frame-reader.js` | NDJSON byte framing with the per-frame cap |
| `src/shared/core/replay-ring.js` | Bounded ring of recent durable frames for client resume |
| `src/shared/core/handler-table.js` | `createHandlerTable` + `validateArgs` against `contract/requests.js` |
| `src/shared/core/request-metrics.js` | Per-request timing/failure rollups |
| `src/shared/core/client-trust.js` | `requireHost` — only the host may stop the worker |
| `src/shared/core/verbose-policy.js` | Verbose on while any client wants it |
| `src/shared/core/store.js` | Single Corestore owner: `createBee`/`createLocalBee`, M-derived key policy |
| `src/shared/core/identity.js` | Resolves master secret M from `identity.enc` |
| `src/shared/core/identity-envelope.js` | Secretbox envelope for M under a KEK; no `bare-*`, unit-tested under Node |
| `src/shared/core/identity-keys.js` | Corestore-identical keypair derivation from M; must stay byte-identical |
| `src/shared/core/subsystem.js` | `Subsystem` lifecycle base + `createLifecycle` ordered start/close |
| `src/shared/core/supervisor.js` | Recovers condemned units of started subsystems; started last |
| `src/shared/core/supervision.js` | Condemn/recover/give-up policy. Pure |
| `src/shared/core/pass-liveness.js` | Per-key pass heartbeats + `stallVerdict` |
| `src/shared/core/intents.js` | Durable intent log + per-kind reconcilers run at boot; no `bare-*` |
| `src/shared/core/timers.js` | Owned timer set; refuses to schedule after close |
| `src/shared/core/concurrency.js` | `mapLimit`, semaphore (express lane), keyed lock, coalescing runner |
| `src/shared/core/coalesce.js` | Keyed leading + trailing coalescer |
| `src/shared/core/hints.js` | `event:reconcile` hint bus (lossy by design; consumers re-derive) |
| `src/shared/core/derived-view.js` | In-memory view folded from watched replicated bees; never persisted |
| `src/shared/core/bee-writer.js` | Serialized read-modify-write over a bee with `cas`; no `bare-*` |
| `src/shared/core/bee-keys.js` | `prefixRange` — the one upper bound for every bee prefix scan |
| `src/shared/core/lru.js` | Refcounted LRU of live handles; in-use entries never evicted |
| `src/shared/core/with-timeout.js` | `withReadTimeout` — bounds peer reads, resolves to a fallback |
| `src/shared/core/cancellation.js` | Cancellation token (`AbortController` is not a Bare global) |
| `src/shared/core/errors.js` | `AppError` + error classifiers; codes come from `contract/errors.js` |
| `src/shared/core/crash-backstop.js` | Uncaught-error handler; exits the worker past a fault rate |
| `src/shared/core/health.js` | Event-loop lag monitor for diagnostics |
| `src/shared/core/logger.js` | Scoped leveled logger gated by `verbose` |
| `src/shared/core/diagnostics-redact.js` | Diagnostics redaction; dependency-free, loads in all three runtimes |
| `src/shared/core/paths.js` | Download-root resolution: global root + per-space overrides |
| `src/shared/core/atomic-file.js` | Crash-safe write: fsync temp, then rename |
| `src/shared/core/reachability.js` | Connectivity verdict (`classify`, `stabilise`); Node-loadable |
| `src/shared/core/dir-tripwire.js` | The tripwire rule over resolved paths; path-module-free, shared by Node and Bare |

### `src/shared/contract/`

The vocabulary all three runtimes share. Imports nothing but its own siblings (`test/unit/contract-package.test.js`); the renderer may import only this package from `src/shared/`.

| File | Purpose |
|---|---|
| `src/shared/contract/requests.js` | One row per worker request: name, kind, arg shape |
| `src/shared/contract/request-args.ts` | Type-only: a request's args derived from its `requests.js` row |
| `src/shared/contract/responses.ts` | Response type per request + the wire shapes; total over `RequestName` |
| `src/shared/contract/request-deadlines.js` | Per-request run-time bound the router reports on |
| `src/shared/contract/events.js` | Every `event:*` name; emit sites checked against it by test |
| `src/shared/contract/errors.js` | Every IPC error code (`CODES`); spellings never renamed |
| `src/shared/contract/ipc-frames.js` | Non-request pipe frames, client kinds, trust, `IPC_PROTOCOL_VERSION` |
| `src/shared/contract/protocol-compat.js` | Wire-version window check |
| `src/shared/contract/hello.js` | Accept/refuse a client's `hello` |
| `src/shared/contract/event-cursor.js` | Client read position on the event stream and what a greeting means |
| `src/shared/contract/main-requests.js` | Every worker→main control frame name |
| `src/shared/contract/workers.js` | Worker entrypoint allowlist |
| `src/shared/contract/exit-codes.js` | Worker exit codes and their meaning to the respawn policy |
| `src/shared/contract/peer-frames.js` | Peer-to-peer `mirall/handshake` frame vocabulary |
| `src/shared/contract/invite-envelope.js` | Invite codec (hand-rolled UTF-8/base64url for all runtimes) |
| `src/shared/contract/principals.js` | Org/person/device key vocabulary; `principalRef` |
| `src/shared/contract/identity-limits.js` | `clampDisplayName`, `sanitizeAvatar` for peer-supplied identity fields |
| `src/shared/contract/limits.js` | Numeric bounds both sides share |
| `src/shared/contract/statuses.js` | Status tuples the renderer derives its unions from |
| `src/shared/contract/mount-fault.js` | Fault code ↔ mount status (errno half: `src/shared/folders/mount-fault.js`) |
| `src/shared/contract/mount-precedence.js` | Owned-mount status precedence; status is derived, never assigned |
| `src/shared/contract/scope.js` | `Scope` + `scopeMatches` — identity of a re-derivable view |
| `src/shared/contract/audit-kinds.js` | Closed audit vocabulary, categories, tiers |
| `src/shared/contract/reachability.js` | Reachability verdict vocabulary |
| `src/shared/contract/deny-outcome.js` | `DENY_OUTCOME` — states the no-revocation rule |
| `src/shared/contract/member-reach.js` | `MEMBER_REACH` vocabulary (`direct` / `relayed`) |
| `src/shared/contract/relay-apply.js` | `relayMismatch` — has a relay change reached live connections |
| `src/shared/contract/paths.js` | Cross-runtime path rules: partial suffix, publish orders, `pathContains`, `PATH_HOST` |
| `src/shared/contract/network-paths.js` | `looksLikeNetworkPath` — routes a path to polled watching |
| `src/shared/contract/decoration-key.js` | Folder-row `event:decoration` key |
| `src/shared/contract/entry-ref.js` | `verified:` bee key grammar + its range prefix |

### `src/shared/spaces/`

Modules in `pureSpacesModules` (`eslint-rules/invariants.mjs`) may not import `bare-*`.

| File | Purpose |
|---|---|
| `src/shared/spaces/space.js` | `spaces-meta` bee owner: space record reads, the one serialized per-space write chain, `SpacesBee` |
| `src/shared/spaces/space-lifecycle.js` | Create, join, materialize on grant, record approval — the only whole-record writers |
| `src/shared/spaces/participation.js` | This peer's participation id per space and its announce |
| `src/shared/spaces/leave-records.js` | Durable leave state (markers, tombstones), record purge, interrupted-leave resume |
| `src/shared/spaces/membership/leave-state.js` | The one leave teardown ORDER, shared by live leave and boot |
| `src/shared/spaces/membership/fold.js` | Pure OR-Set membership fold and its helpers |
| `src/shared/spaces/member-view.js` | Transitive member discovery + derived member view |
| `src/shared/spaces/member-registry.js` | One live member view per space, reconciled into `space.members`; `MemberViews` |
| `src/shared/spaces/member-fanout.js` | "Own + every member" peer fan-out under one budget |
| `src/shared/spaces/profile.js` | Own replicated profile bee: identity, membership manifest, per-space key announcements; `ProfileBee` |
| `src/shared/spaces/peer-bee.js` | Bounded reads of peers' profile bees (`withPeerBee`) — one budget per read, never a second |
| `src/shared/spaces/peer-profile-watch.js` | The one held profile-bee session per peer + avatar fetch |
| `src/shared/spaces/join-requests.js` | In-memory pending/derived join requests; not persisted |
| `src/shared/spaces/knock-policy.js` | Join-request (knock) verdict tables |
| `src/shared/spaces/invites.js` | Classify an incoming `inviteId` |
| `src/shared/spaces/creator-root.js` | Adopt/confirm/refuse rule for a member-set root assertion |
| `src/shared/spaces/creator-pin.js` | Persists the creator-root pin + one-shot boot backfills |
| `src/shared/spaces/space-keys.js` | SCK vault (`space-keys.enc`) owner; `SpaceKeysVault` |
| `src/shared/spaces/space-keys-codec.js` | Vault plaintext codec (v1/v2, epochs) |
| `src/shared/spaces/sck-seal.js` | Seals the SCK to a joiner's signer key at approval |

### `src/shared/shares/`

`catalog-keys` and `catalog-tally` are pure (`pureSharesModules`).

| File | Purpose |
|---|---|
| `src/shared/shares/shares.js` | Share records (`share/<spaceId>/<shareId>` rows on profile bees) |
| `src/shared/shares/share-registry.js` | Own + members' share records merged for a space |
| `src/shared/shares/catalog-keys.js` | Catalog key grammar and key-field convention; `FILE_PREFIX` is PERSISTED |
| `src/shared/shares/own-catalog.js` | Owner's SCK-encrypted per-space catalog bee; `OwnCatalogs` |
| `src/shared/shares/peer-catalog.js` | Peers' catalogs read-only behind a refcounted LRU; `PeerCatalogs` |
| `src/shared/shares/catalog-writer.js` | Batched catalog writes for a bulk publish pass |
| `src/shared/shares/catalog-tally.js` | Single-pass count / byte-sum / cap fold for listings |
| `src/shared/shares/share-listing.js` | Display listing for one folder share |
| `src/shared/shares/migrate-catalog-encrypt.js` | One-shot plaintext → encrypted catalog migration |

### `src/shared/folders/`

Owner side: `owned-*`, publish lane: `publish-*`, mirror engine: `mirror-*`, mirror mount lifecycle: `foreign-*`. The two `*-folders.js` roots are never imported back by their leaves. Modules in `pureFolderPolicyModules` (`eslint-rules/invariants.mjs`) may not import `bare-*`.

| File | Purpose |
|---|---|
| `src/shared/folders/owned-folders.js` | Owner-side composition root; `OwnedFolders` |
| `src/shared/folders/owned-pass.js` | One owner reconcile pass: diff → enqueue → settle |
| `src/shared/folders/owned-watcher.js` | Watcher event → interactive work item; catch-up diff |
| `src/shared/folders/owned-channel.js` | The `folder` publish channel: resolves items against current mount state |
| `src/shared/folders/owned-progress.js` | Throttled index-progress frames + re-announce |
| `src/shared/folders/owned-state.js` | Owner state kept between passes |
| `src/shared/folders/owned-shares.js` | Share record behind an owned mount |
| `src/shared/folders/owned-policy.js` | `ownedKey`, `publishVerdict`, `worsePassFault` |
| `src/shared/folders/owned-preview.js` | Owner pre-mount scan preview |
| `src/shared/folders/publish-service.js` | Shared owner-side publish lane + channel registry; `PublishService` |
| `src/shared/folders/publish-scheduler.js` | Cross-space bulk/express slot scheduler |
| `src/shared/folders/publish-queue.js` | One space's work queue, one live item per path |
| `src/shared/folders/work-item.js` | Path-keyed work item, states, priorities, comparators |
| `src/shared/folders/retire-confirm.js` | Confirm-gone-twice before retiring a catalog entry |
| `src/shared/folders/foreign-folders.js` | Mirror-side composition root; `ForeignMirrors` |
| `src/shared/folders/foreign-verbs.js` | Mirror mount verbs: record write + loop control |
| `src/shared/folders/foreign-pause.js` | Mirror pause / fault / resume ladder |
| `src/shared/folders/foreign-orphan.js` | Unmount a mirror only on positive evidence its share is gone |
| `src/shared/folders/foreign-shares.js` | Owner's share record behind a mirror |
| `src/shared/folders/foreign-preview.js` | Mirror pre-mount scan preview |
| `src/shared/folders/mirror-loop.js` | Per-mount loop: interval, one pass in flight, dirty flag, generation |
| `src/shared/folders/mirror-pass.js` | Restartable materialize pass over a share's catalog |
| `src/shared/folders/mirror-fetch.js` | Per-entry fetch; owns state that outlives a pass |
| `src/shared/folders/mirror-state.js` | Per-mount synced set, rename map, watermark |
| `src/shared/folders/mirror-policy.js` | Mirror decisions: `mirrorKey`, local-copy verdict, walk/fetch/stall rules |
| `src/shared/folders/mirror-budgets.js` | Per-(path, hash) attempt budget and integrity-row cap |
| `src/shared/folders/mirror-watcher.js` | Mirror fs event → walk request |
| `src/shared/folders/mirror-signals.js` | Mirror status event + participation record sync; the mirror side's one IPC slot |
| `src/shared/folders/mirror-records.js` | Replicated `mirror/<spaceId>/<shareId>` participation rows |
| `src/shared/folders/mirror-registry.js` | "Who mirrors what" for a space or share |
| `src/shared/folders/pass-writer.js` | Generation-scoped writer: a cancelled pass never writes after its canceller |
| `src/shared/folders/mount-store.js` | `mounts-meta` owner for both mount kinds; `MountsBee` |
| `src/shared/folders/mount-validate.js` | Mount-path and download-folder validation rules |
| `src/shared/folders/mount-fault.js` | Mount-fault vocabulary for the worker + `faultFromError` |
| `src/shared/folders/folder-intents.js` | Boot reconcilers for multi-bee folder flows |
| `src/shared/folders/path-keys.js` | Pure cross-platform path math, ignore globs, overlap, deletion gate |
| `src/shared/folders/path-guard.js` | `pathFromMount` — the one guarded mount-relative join (traversal guard) |
| `src/shared/folders/walk-disk.js` | Stat-only recursive walk of a mount root |
| `src/shared/folders/disk-presence.js` | Exact-name presence checks before a retire |
| `src/shared/folders/echo-guard.js` | TTL set of our own writes so watchers ignore them |
| `src/shared/folders/watch-tree.js` | `bare-fs` watcher per root in add/change/unlink vocabulary |
| `src/shared/folders/watch-derive.js` | Watch mode + settled-action decisions |
| `src/shared/folders/watch-budget.js` | Linux inotify watch accounting |
| `src/shared/folders/preview-tally.js` | Shared preview result shape + per-file detail cap |
| `src/shared/folders/share-limits.js` | The one folder-share file-limit rule |

### `src/shared/network/` — reachability and swarm plumbing

The modules that import no `bare-*` (Node-loadable, unit-driven) are listed in `pureNetworkModules`
in `eslint-rules/invariants.mjs`; that list is the statement, not the rows below.

| File | Role |
|---|---|
| `src/shared/network/swarm.js` | Control-plane composition root: DHT + Hyperswarm, the `Swarm` subsystem. Nothing runs at import |
| `src/shared/network/peer-connection.js` | One accepted socket: replication, the `mirall/handshake` channel, backend channels bound before open, teardown |
| `src/shared/network/handshake-apply.js` | Applies an admitted handshake and its disconnect teardown; the emit order is load-bearing (§4.2) |
| `src/shared/network/handshake-guard.js` | Frame-shape checks, Noise-key identity binding, leave / grant assertions, rate limiters (§4.2, §16) |
| `src/shared/network/identity-frames.js` | Our outbound `handshake` / `membership:request` frames and their binding; `sendFrame`, profile broadcast |
| `src/shared/network/membership-frames.js` | Outbound grant / deny (one peer) and cancel (every socket: a pending joiner has no membership) |
| `src/shared/network/frame-intake.js` | Every inbound frame's gate: size cap and budget charged before decode, shape, identity, routing (§4.2) |
| `src/shared/network/admission-gates.js` | The approval and creator-root checks a handshake asks before registering a peer (§4.2) |
| `src/shared/network/deferred-admission.js` | Re-admits a parked joiner once an approval replicates in or a space is re-entered |
| `src/shared/network/swarm-registries.js` | The shared peer / socket / topic maps and `announceLedger`, with the reads and sends over them (§4.4) |
| `src/shared/network/announce-ledger.js` | Level-triggered retry ledger for identity frames still awaiting their implicit ack |
| `src/shared/network/space-topics.js` | Join / leave a space topic, throttled `reconnectAll`, handshake on reused sockets, leave-side eviction |
| `src/shared/network/leave-protocol.js` | Inbound `leave` apply, the leaving marker, leave acks, pending-leave / pending-cancel replay (§4.2, §6) |
| `src/shared/network/convergence-tick.js` | The slow level-triggered re-drive of every observable deficit; idle when converged |
| `src/shared/network/presence.js` | `createPresence`: the receiver-controlled TTL lease primitive, in memory only (§4.7) |
| `src/shared/network/presence-leases.js` | The one presence-lease store; domains read it without importing the connection layer (§4.7) |
| `src/shared/network/presence-broadcast.js` | Heartbeat / departure and share-prepare / index-progress frames, send and apply (§4.7) |
| `src/shared/network/share-wait.js` | The `share-wait` frame (member → owner): send, the member's `memberWaits` singleton, owner handler (§3.5) |
| `src/shared/network/share-wait-intake.js` | Which inbound `share-wait` notices the owner accepts as waiting rows. Pure |
| `src/shared/network/content-swarm.js` | Bulk-content plane: a second Hyperswarm on the shared DHT carrying only the overlay channel (§7.6) |
| `src/shared/network/content-peer-sockets.js` | Which authenticated identities ride which content socket; the per-peer teardown rule |
| `src/shared/network/connectivity.js` | Swarm-fact ledger for our own reachability; wires canary probe, link liveness and status frame |
| `src/shared/network/canary-probe.js` | Two-stage seeder probe (DHT lookup, then an ephemeral dial); the newest verdict wins |
| `src/shared/network/link-liveness.js` | Detects a silently-dead link: routable-interface poll plus routing-table ping |
| `src/shared/network/network-status.js` | The `event:network-status` frame: verdict fold, dedup / debounce emit, audit hook; works without a `Swarm` |
| `src/shared/network/swarm-diagnostics.js` | Read-only snapshot builders over the live swarm |
| `src/shared/network/support-bundle.js` | The redacted `diagnostics:export` bundle; only device-level audit rows may enter it |
| `src/shared/network/member-reach.js` | Per-member direct / relayed fold over their live sockets (relayed if any one is). Pure |
| `src/shared/network/relay.js` | Pure relay rules: enabled keys, seeded identity, the per-mode `relayThrough` function (§4.8) |
| `src/shared/network/relay-ticket.js` | The frozen 69-byte ticket codec shared with `mirall-relay`; any change is a protocol change (§4.8) |
| `src/shared/network/relay-install.js` | Installs the relay on BOTH swarms, probes one, wires the observer and connection tracking (§4.8) |
| `src/shared/network/relay-observe.js` | Wraps `blind-relay`'s `Client.from` to record which relay paired a stream, own or adopted (§4.8) |
| `src/shared/network/relayed-connections.js` | Live relayed / direct connections on both planes; own / adopted provenance fixed at pairing (§4.8) |
| `src/shared/network/net-impair.js` | Test-only link shaper (runtime-config `netImpair`); production never sets it |

### `src/shared/transfer/`

The no-`bare-*` modules are listed in `pureTransferModules` in `eslint-rules/invariants.mjs`.

| File | Role |
|---|---|
| `src/shared/transfer/content-backends.js` | The seam: `getContentBackend(share)` → overlay or `UNSUPPORTED`; presence-sweep fan-out (§7.6) |
| `src/shared/transfer/files.js` | The `downloads-meta` bee — claims, `verified:`, `src:` records — and the claim verdicts; `DownloadsBee` (§3.3) |
| `src/shared/transfer/file-listing.js` | A space's loose listing (catalog, claims, pending rows, disk folded per file) and `addFile` / `removeFile` (§3.5) |
| `src/shared/transfer/file-dedupe.js` | Folds per-owner loose candidates into one row per file, most-progressed wins (§3.5) |
| `src/shared/transfer/listing-memo.js` | Per-catalog `files:list` memo of entries only, watermarked on catalog version |
| `src/shared/transfer/list-deficits.js` | Spaces whose last listing gave up on a peer catalog; the convergence tick drains it (§4.3) |
| `src/shared/transfer/transfer-status.js` | The one consumer-row status ladder for loose, folder and mirror rows (§7.3) |
| `src/shared/transfer/transfer-id.js` | The `spaceId\|shareId\|relPath` wire id, `LOOSE_SHARE_ID`, loose routing predicate |
| `src/shared/transfer/pending-transfers.js` | The `pending-transfers` bee with a per-row write order; `PendingTransfersBee` (§3.4) |
| `src/shared/transfer/download-claim.js` | `claimVerdict`: the downloaded / keep / prune ladder for one claim (§3.3) |
| `src/shared/transfer/download-dest.js` | Collision-free destination naming and the resume re-anchor rule (§3.5) |
| `src/shared/transfer/verified-copy.js` | The one "is this local file still the verified one?" rule, shared by engine and listing |
| `src/shared/transfer/supersede-decision.js` | Decisions for an in-flight transfer whose owner's catalog changed (§4.5) |
| `src/shared/transfer/partial-suffix.js` | App-side re-export of `PARTIAL_SUFFIX` / `partialPathFor` (defined in `contract/paths.js`) |
| `src/shared/transfer/partial-sweep.js` | Boot sweep of `.mirall.part` files no pending row or journal references (§3.5) |
| `src/shared/transfer/temp-paths.js` | `isEphemeralSourcePath`: rejects macOS promised-file temps as share / drop sources |
| `src/shared/transfer/free-space.js` | `shortfall()` arithmetic with headroom; Node-loadable half |
| `src/shared/transfer/free-space-probe.js` | The one `statfs` probe (`bare-fs`), fails open |
| `src/shared/transfer/progress-ticker.js` | Throttled `{bytes,total,speed,eta}` ticker every overlay fetch path shares |
| `src/shared/transfer/eta-estimator.js` | Size-adaptive blended ETA behind every progress source |
| `src/shared/transfer/bandwidth-limiter.js` | Global byte token bucket with deficit round-robin fairness for the content plane (§7.6) |
| `src/shared/transfer/chunk-map-cache.js` | Byte-bounded LRU of decoded chunk maps, injected into the vendored `FileIndex` (§7.6) |
| `src/shared/transfer/serve-ledger.js` | Sender-side "who is downloading from us": summary and per-peer detail tiers, share-wait waiters |
| `src/shared/transfer/serve-sessions.js` | Folds start / end serve activity into one audit row per session. Pure, clock-injected |
| `src/shared/transfer/share-wait-set.js` | The member's in-memory set of files waited on, with per-source lifetimes. Pure, send injected |
| `src/shared/transfer/transfer-activity.js` | `transfersMoving()`: is any download or serve moving now (asked before a transport change) |
| `src/shared/transfer/reveal.js` | Show-in-file-manager: resolves a download's claim path or an owned file's source (§3.3) |
| `src/shared/transfer/reveal-exit.js` | `revealExitIsFailure`: `explorer.exe` exits 1 on success |

### `src/shared/transfer/backends/overlay/`

The one content backend: engine, serve side and catalogs over the vendored `hyper-overlay` v2.

| File | Role |
|---|---|
| `src/shared/transfer/backends/overlay/index.js` | The `overlayBackend` contract object the seam hands out; lifecycle is `OverlayBackend`'s |
| `src/shared/transfer/backends/overlay/overlay-runtime.js` | `OverlayBackend` subsystem: instance, serve index and both engines as one lifetime. Only boot imports it |
| `src/shared/transfer/backends/overlay/overlay-instance.js` | The process-global `HyperOverlayV2`: construction with injected collaborators, mux attach, serve revocation |
| `src/shared/transfer/backends/overlay/overlay-authorize.js` | The serve gate as a pure truth table: `DENY` + `makeServeAuthorizer`; a deny is a silent drop (§16) |
| `src/shared/transfer/backends/overlay/overlay-serve-index.js` | In-memory `contentHash` → advertising paths refcount the serve gate reads |
| `src/shared/transfer/backends/overlay/serve-registration.js` | Keeps `serveIndex` and the overlay path map in lockstep, refcounted per path |
| `src/shared/transfer/backends/overlay/overlay-hash.js` | The wire-compatible content hash of a file on disk; the only valid comparison with a catalog hash |
| `src/shared/transfer/backends/overlay/overlay-publish.js` | Publish / retire core shared by folder and loose: advertise-null, hash, serve |
| `src/shared/transfer/backends/overlay/publish-progress.js` | The publishing-progress reporter both publish sides use |
| `src/shared/transfer/backends/overlay/folder-publish.js` | Folder-share publish side: `publishAdd` / `publishDelete` over the core, owner view refresh |
| `src/shared/transfer/backends/overlay/loose-publish.js` | Loose owner side: source map, watch, per-space cap, `loose` publish channel, cancel / unshare |
| `src/shared/transfer/backends/overlay/overlay-refresh.js` | `makeSharesRefresh`: coalesces owner-side share-files refreshes per share |
| `src/shared/transfer/backends/overlay/overlay-maintenance.js` | Single-flight index compaction, the boot rehydrate and presence sweep over own shares (§7.6) |
| `src/shared/transfer/backends/overlay/overlay-channel.js` | One factory for the consumer channel the engine drives, loose and folder alike |
| `src/shared/transfer/backends/overlay/folder-downloads.js` | Folder-share consumer side: peer-catalog list / watch, `folderChannel`, downloads |
| `src/shared/transfer/backends/overlay/loose-downloads.js` | Loose consumer side: peer-catalog list / watch, `looseCatalogVersion`, `looseChannel`, downloads |
| `src/shared/transfer/backends/overlay/folder-job.js` | Builds a folder engine download job. Pure |
| `src/shared/transfer/backends/overlay/loose-job.js` | Builds a loose engine download job; the loose drive-path grammar. Pure |
| `src/shared/transfer/backends/overlay/overlay-download.js` | The consumer download engine root (one per channel): slot registry, user verbs, sibling wiring (§4.5) |
| `src/shared/transfer/backends/overlay/download-start.js` | How a download begins: slot reservation, durable row, preflight, supersede restart |
| `src/shared/transfer/backends/overlay/fetch-settle.js` | The gated half: fetch gate, vendor call, one settle per verdict; owns completion-write order |
| `src/shared/transfer/backends/overlay/settle-verdict.js` | The precedence a finished fetch is judged by and why a reserved slot abandons. Pure |
| `src/shared/transfer/backends/overlay/reconcile-scan.js` | Level-triggered recovery of inactive pending rows on reconnect or append |
| `src/shared/transfer/backends/overlay/active-transfers.js` | Cancel a space's transfers on leave; reconcile active slots after an append |
| `src/shared/transfer/backends/overlay/stall-retry.js` | Retries a fetch whose bytes stopped while the owner stays online; owns a timer per transfer (§4.5) |
| `src/shared/transfer/backends/overlay/single-flight-scan.js` | Keyed, debounced, non-stacking scan scaffold for the resume and reconcile drivers |
| `src/shared/transfer/backends/overlay/download-faults.js` | Which `ErrorCode` a refused or failed download gets, and when a user-blocked fault has cleared. Pure |
| `src/shared/transfer/backends/overlay/fetch-policy.js` | Fault classes, miss classification and retry delay for every producer. Pure |
| `src/shared/transfer/backends/overlay/fetch-outcome.js` | `FETCH_OUTCOME`: the closed outcome vocabulary. Imports nothing |
| `src/shared/transfer/backends/overlay/fetch-run.js` | One instrumented vendor fetch; the mirror's `runOverlayFetch` |
| `src/shared/transfer/backends/overlay/fetch-gate.js` | Process-wide "who is fetching this transferId" registry: engine probes and mirror claims |
| `src/shared/transfer/backends/overlay/paused-holders.js` | Paused-transfer markers and the "tell the holder we stopped" primitives |
| `src/shared/transfer/backends/overlay/migrate-overlay-index-encrypt.js` | One-shot copy of the plaintext file-index cores into the encrypted namespace, then purge |
| `src/shared/transfer/backends/overlay/vendor/` | Vendored `hyper-overlay` v2 subset; `PROVENANCE.md` records every local change, re-diffable upstream. No app imports (§7.6) |

### `src/shared/storage/` and `src/shared/sweep/`

| File | Role |
|---|---|
| `src/shared/storage/storage.js` | Store footprint for the Storage screen and the boot leftover sweep entry (§2, §14) |
| `src/shared/storage/space-storage.js` | Per-space `{ totalBytes, onDeviceBytes }` behind the space storage widget |
| `src/shared/storage/compaction.js` | Serialized forced blob-GC compaction; two passes must never overlap (§7.6) |
| `src/shared/storage/core-purge.js` | The RocksDB core / alias purge primitives every reclaim goes through; direct tombstones |
| `src/shared/storage/leftover.js` | Wanted-set builder, leftover classifier and purge, leave-time peer-core GC |
| `src/shared/storage/sweep-journal.js` | Forensic `purge/…` rows in `reclaim-meta`: what each sweep deleted or refused |
| `src/shared/storage/retired-drive-cores.js` | Finds and purges a retired per-space drive's metadata and blobs cores by key |
| `src/shared/sweep/sweep-rules.js` | `decideSweep`: fail-closed go / no-go for one leftover sweep. Pure (§14) |
| `src/shared/storage/migrations/index.js` | The one-shot install migrations as one ordered list, plus the per-stage runner (§2) |
| `src/shared/storage/migrations/migration-result.js` | `STAGES`, `MIGRATION_STATUS`, `migrationResult`. A leaf that imports nothing |
| `src/shared/storage/migrations/metadata-migration.js` | One-shot plaintext → encrypted copy of every `LOCAL_BEE_NAMES` bee; frozen marker name (§16) |
| `src/shared/storage/migrations/retire-space-drives.js` | One-shot purge of retired per-space drives; waits for a boot with the master secret |

### `src/shared/audit/`

| File | Role |
|---|---|
| `src/shared/audit/audit-runtime.js` | `AuditLog` subsystem: the bee and the network watch open and close together |
| `src/shared/audit/audit-log.js` | The local-only `audit-log` bee's handle and write path (`record`, `recordResolved`). Imports only `core/` and audit siblings |
| `src/shared/audit/audit-keys.js` | The bee's key layout and range builders. Pure |
| `src/shared/audit/audit-record.js` | `buildRecord()`: row schema with name snapshots (no joins at render time). Pure |
| `src/shared/audit/audit-query.js` | Budget-bounded reads: paginated listing, filter vocabularies, stats, export |
| `src/shared/audit/audit-retention.js` | Prune-boundary math with clock-jump hysteresis. Pure |
| `src/shared/audit/audit-reclaim.js` | `pruneAudit` (rows) and `purgeAudit` (bytes) |
| `src/shared/audit/audit-rate-guard.js` | Per-kind token bucket reporting a suppressed count. Pure, clock-injected |
| `src/shared/audit/audit-watch-state.js` | The watches' durable state in the bee: peer-bee watermarks, recorded peer and device states |
| `src/shared/audit/peer-records-observer.js` | Diff of a peer's bee: key classification, transition dedupe, bounded history read. Pure |
| `src/shared/audit/peer-records-watch.js` | Wires that diff into the data layer with relevance gates; `PeerWatch` |
| `src/shared/audit/presence-episodes.js` | Folds peer presence flapping into one row per real absence. Pure, clock-injected |
| `src/shared/audit/connectivity-episodes.js` | Folds the device connectivity verdict into rows. Pure, clock-injected |
| `src/shared/audit/network-watch.js` | I/O half of both trackers and the relay rows; a peer row is written only while we are healthy |
| `src/shared/audit/transfer-audit.js` | One row per finished consumer download, called by the engine, never a channel |

### `src/shared/telemetry/` and root

| File | Role |
|---|---|
| `src/shared/telemetry/feedback.js` | User-initiated feedback POST (`bare-https`) with install id, version and channel headers |
| `src/shared/telemetry/install-id.js` | Mints and persists the anonymous per-install UUID; unrelated to any identity key |
| `src/shared/telemetry/channel.js` | `deriveChannel`: `dev` / `staging` / `prod` from the version string. Dependency-free |
| `src/shared/package.json` | `"type": "module"` |

### `src/renderer/`

Directory-level rows. The root holds only `main.tsx`, `app.tsx`, `ScreenRouter.tsx` and
`package.json`; every other module sits in a kebab-cased bucket (`renderer-root-is-empty.test.js`).

| File / dir | Role |
|---|---|
| `src/renderer/main.tsx` | Entry: platform side-effect imports, store transports and push bridges, `createRoot` |
| `src/renderer/app.tsx` | `App` boot gate (loading → onboarding → shell) and `AppShell` provider / dialog composition |
| `src/renderer/ScreenRouter.tsx` | Maps the current screen to its screen component |
| `src/renderer/ipc/` | Worker IPC client (`request`, `subscribe`, resync, respawn orchestration) and the pure respawn policy |
| `src/renderer/store/` | The worker query store and main-process store with their hooks and reconcile bridges (§8) |
| `src/renderer/hooks/` | React hooks; shared rules in `hooks/README.md`, off-store exceptions say why in their headers (§8) |
| `src/renderer/model/` | Pure view-models derived from worker data; plain JS typed by JSDoc, Node-testable |
| `src/renderer/shell/` | Cross-screen shell logic: screen graph (§10), screen titles, cross-screen actions, docs links |
| `src/renderer/screens/` | One `*Screen.tsx` per screen; the settings family under `screens/settings/` |
| `src/renderer/components/` | Components by area: `primitives/`, `layout/`, `modals/`, `folder/`, `space/`, `network/`, … (§10) |
| `src/renderer/keyboard/` | Command registry and provider, accelerators, command palette, shortcuts hint |
| `src/renderer/notifications/` | OS-level notifications: dispatcher, click router, prefs, coalescing (distinct from toasts) |
| `src/renderer/platform/` | Platform glue: bridge types, theme, i18n, config cache, updates, window bounds, dev console, relay session |
| `src/renderer/errors/` | The backend-code → i18n-key map and `errorTextFor`, the single place a failure becomes text |
| `src/renderer/format/` | Display formatting: sizes, speed, ETA, dates, status values |
| `src/renderer/types/` | Renderer-only types; wire types are re-exported from `src/shared/contract/` |
| `src/renderer/locales/` | `<code>/common.json` + `<code>/errors.json` per locale, statically bundled |
| `src/renderer/styles/tailwind.css` | Fonts, custom utilities, glass classes; see `design.md` |

## 12. Dependencies

`package.json` is the source of truth for versions. Pins and bump procedure are in `dependency-updates.md`, which covers the `hyperdht` ceiling and its `overrides` entry, the dev-only `hyperdrive` pin, and `@react-types/shared` as react-aria's twin. The constraints below are not visible from the manifest:

| Dependency | Constraint |
|---|---|
| `pear-runtime` | Exact pin. It brings `pear-runtime-updater`, which main also resolves directly for OTA, so a surprise minor can change update behaviour |
| `chokidar` | Electron main only, with `src/main/watch-host.js` as its single owner (invariant-tested). All production filesystem watching runs in main. `src/shared/folders/watch-tree.js` (Bare `fs.watch`) exists and is tested, but nothing in production imports it |
| `bare-fs` / `-path` / `-os` / `-subprocess` / `-https` | Bare stdlib, used by the worker and `src/shared` only. A module that imports them at top level loads only under Bare |
| `hypercore-storage` | **Not declared.** It is a corestore transitive that `src/shared/storage/core-purge.js` deep-imports (`lib/keys.js`) to write RocksDB range tombstones. A corestore upgrade can change that key layout without any manifest change |
| `eslint-plugin-jsx-a11y` / `@axe-core/react` | The first is a build and CI gate; the second is a dev-only runtime checker |

---

## 13. Build & Distribution Pipeline

The release pipeline (channels, CI, R2, seeding, signing) is in `build-process.md` and is authoritative. Script definitions are in `package.json`. This section records only what the application source depends on.

**Linux packaging.** `make:linux` runs the deb maker *before* `scripts/build/build-app-image.sh`, because forge's `preMake` wipes `out/make`. Both are built from one packaged tree.

- **Sandbox.** The deb installs to `/usr/lib/mirall/` with `chrome-sandbox` setuid, so it runs with the Chromium sandbox on. The AppImage cannot, because its payload is extracted as the user, so `resources/linux/AppRun` passes `--no-sandbox`.
- **FUSE.** The AppImage swaps its FUSE runtime for uruntime in extract-and-run mode (the `URUNTIME_VERSION` pin in the script), because current distros lack `libfuse2`.
- **OTA.** `linuxInstallKind` (`src/main/install-kind.js`) recognises a deb install (execPath under `/usr/lib/mirall/`, no `APPIMAGE`) and turns OTA off. Root owns the swap target and the package manager owns updates.
- **Shared data.** Both packagings use the same `~/.config/mirall/`. A deb install retires any per-user AppImage desktop entry (`retireXdgAppImageEntry`).
- **Compression.** The deb uses xz members, because dpkg before Debian 12 can't read zstd. `scripts/ci/check-deb.sh` checks the package on every CI build.

**Asar.** `forge.config.js` seals `src/main`, `src/preload` and the built renderer into `app.asar`. It unpacks `src/worker`, `src/shared`, `node_modules`, `resources` and every `*.{node,bare}`. The reasons:

- Bare has no asar support, so it can't load its entry, its JS or `.bare` modules from an archive.
- `bare-sidecar` `chmod`s its binary on first launch.
- `dlopen` can't read from an archive.
- Native notification and tray APIs take real file paths.

`src/main/asar-spawn.js` rewrites `app.asar/` → `app.asar.unpacked/` in spawn paths and argv, because `require.resolve` returns archive paths the OS can't exec. The asar is deliberately **uncompressed** (binary form, not size or obfuscation). Real obfuscation such as bytecode is deferred until there is a threat model. OTA is unaffected, since `fsx.swap` replaces the whole bundle.

---

## 14. Known Limitations & Future Work

- **Invite links gate reading, not knocking.** Anyone holding an unexpired, unrevoked code can join the topic and send join requests. Read access still requires approval (the SCK grant, §16).
- **Some transfer faults wait for the user.** A checksum fault clears only when the owner republishes. Disk-full from a write-time ENOSPC always needs Retry. Permission, missing-folder and preflight disk-full faults clear themselves once the destination recovers (`faultCleared`, `src/shared/transfer/backends/overlay/download-faults.js`).
- **Large folders are bounded by a cap, not paged.** One number (`maxFilesPerShare` = `listFilesCap`) is both the admission gate and the display ceiling, so an admitted share renders in full. There is no paging or virtualization, and hundreds of thousands of entries would still strain the single Bare worker.
- **Departed members can linger.** Leave convergence rides the leaver's own `member/<S>` record. A peer that was offline at leave time keeps the member in its roster until that record replicates, and there is no third-party witness path.
- **The boot leftover sweep is irreversible.** The sweep fails closed (`src/shared/sweep/sweep-rules.js`): any gap in the wanted-set scan refuses the whole sweep, and absolute and ratio caps bound it. Refusals are journaled and retried at the next boot. A sweep that passes still hard-deletes by RocksDB range delete, with no undo and no audit row.
- **Mirror writes and deletions are unaudited.** A diverged local edit is moved aside before an overwrite (`preserveLocalEdit`), and deletions are ratio-capped (`shouldHonorDeletions`). Still, mirrored files are not made read-only, unlinks bypass the trash, and neither overwrites nor deletions write an audit row.
- **A deleted folder share leaves its catalog rows.** `owned-folder:delete` tombstones only the share record. Each file's path, size, mtime and hash stays in the owner's catalog for the life of the space.
- **Cancellation is mostly a discard.** Only `share:list-files` and the two folder-preview requests read `ctx.signal`. For every other request, a cancel drops the response while the worker finishes the work.
- **Preload has no structural contract.** `src/preload/preload.js` is sandboxed and unbundled, so it can't import `src/shared/contract/`. `test/invariants/preload-parity.test.js` checks its key set against `src/renderer/platform/global.d.ts`, but nothing checks signatures.
- **The vendored overlay has no static analysis.** eslint and knip ignore `vendor/**`, and tsc doesn't cover `src/shared` beyond `contract/`. The vendored code has taken substantial local changes (see `PROVENANCE.md`), so its tests are what protect it.

---

## 15. Testing & Accessibility

The layers, the coverage matrix, the a11y bar and the CI composition are in `testing.md`, which is authoritative. Each `test/<layer>/` has a README. Two facts that don't appear there:

- The frontend suite (`test/frontend/`, local-only) is the **only** layer that drives the real chokidar → publish → replicate → materialize path.
- `lint:ci`'s comment-hygiene gate (`scripts/ci/check-comment-hygiene.sh`) lets source comments point at exactly one doc: `.claude/solution-architecture.md`. `test/invariants/arch-doc-module-table.test.js` requires every backticked `src/…` path in `.claude/*.md` to exist, and requires §11 to have a row for every data-layer, main and worker module.

---

## 16. Identity & Security Model

### Master secret (M) & key derivation

A 32-byte **master secret M** roots every writable core's keypair and every local encryption key. `src/shared/core/identity-keys.js` reproduces Corestore's derivation byte-for-byte, and content keys use a separate namespace. M exists on disk only in `identity.enc`, wrapped (secretbox) under a **KEK** from a pluggable unlock provider.

The default provider is a random KEK stored as `kek.enc`, encrypted with Electron `safeStorage` (`src/main/identity-kek.js`). Main passes the worker the KEK, never M. **On Linux with no keyring, safeStorage falls back to `basic_text`**, so protection degrades to disk encryption rather than failing to start.

**The RocksDB seed is never the identity.** A fresh install gets an independent random M. A store that predates the envelope keeps its seed as M, fsyncs the envelope, then replaces the seed and makes a best-effort attempt to compact away the old blocks (`src/shared/core/identity.js`).

### Encryption at rest

The local-only bees (`LOCAL_BEE_NAMES` in `src/shared/core/store.js`: spaces, downloads, pending transfers, reclaim, mounts, migrations and the audit log) are encrypted under an M-derived key. The overlay's local index cores are encrypted under a second M-derived key. Anything peers must read is not encrypted with M:

- The **profile bee replicates in plaintext**.
- Share catalogs are encrypted with the space's SCK (§3.7).

### Space content key (SCK)

Each space has a symmetric key that encrypts its catalogs. **Holding the SCK is read access**, which makes approval a cryptographic gate.

- The creator derives epoch 0 from M.
- Joiners receive the key at approval, sealed to their bound ed25519 signer key (`src/shared/spaces/sck-seal.js`).
- Members keep keys in the vault `space-keys.enc`, which is wrapped under an M-derived key and holds each space's current epoch plus its history.
- Every key carries an **epoch**, named by the space record, the vault entry, the published catalog key and the grant frame. A missing field reads as 0.
- Only epoch 0 can be re-derived, and only by the creator. After a rotation, even the creator holds the key only in the vault. No code path mints an epoch above 0 yet.

### Principals: org, person, device

The contract (`src/shared/contract/principals.js`) names three tiers: `PersonKey`, `DeviceKey` and `OrgKey`. Today person and device both equal the profile key, which is the hex manifest hash of the profile core. `orgKey` is always null. `principalRef()` is the one place that equality is written down, so a future device roster changes one function.

A **Noise key is never an identity**: it identifies one socket, and a peer's control and content sockets have different ones. The **wire spelling doesn't follow the vocabulary**. Frames keep `profileKey` / `granterKey` / `joinerKey` and bees keep `publicKey`, because there is no frame-version negotiation. A renamed field fails `validSenderFrame` and is dropped, so two versions would connect and never become members of each other.

### Handshake identity binding

Handshake, membership request/grant and leave frames carry a signature from the profile signer over the socket's Noise key; handshakes also cover the participation id (V2). `src/shared/network/handshake-guard.js` checks the signer against the claimed profile key's manifest and verifies the signature. The result: frames are attributable, and a third party can't impersonate a member or evict one.

- **Enforcement for handshake and grant frames depends on the `handshakeIdentityBindingEnabled` flag.** `feature-flags.json` ships it on, but the runtime-config default is off. A failed flag read (`src/main/feature-flags.js`) therefore silently accepts unbound frames, and the socket-to-identity map then trusts the claim.
- Leave frames are always checked.
- The V2 participation-id binding is best-effort: a V1 signature over the Noise key alone still verifies during rolling upgrades.

### Membership

Joining is request → approval. A **membership grant** carries the sealed SCK and asserts the space's member-set root (the creator), authenticated by the granter's binding. **A plaintext SCK is refused as a downgrade**, and the sealed field is length-bounded. Rosters fold as an **OR-Set** with tombstones. The root is pinned to the creator and adopted only from an authenticated assertion, which requires enforcement to be on. A root taken from a bearer invite hint stays *provisional* (`creatorUnverified`) until confirmed.

### Serve authorization

File bytes are served only when all three gates pass (`src/shared/transfer/backends/overlay/overlay-authorize.js`, wired in `overlay-instance.js`):

1. The requester's profile key is authenticated on the requesting socket (control or content plane). This is only as strong as the binding enforcement above.
2. A per-requester rate limit admits the request. This gate is skipped when re-validating a grant this peer already issued, such as on an epoch bump.
3. The requester is an approved member of some space that advertises the content hash.

**A denial looks exactly like "I don't hold this file"**, so membership can't be probed. Locally, only `UNAUTHENTICATED` and `NOT_A_MEMBER` count as refusals and are audited as `security.serve_denied`. `NO_SOCKET`, `RATE_LIMITED` and `NOT_HELD` are normal operation and record nothing: a multi-source fetch sends its request to every connected peer, so being asked for unadvertised content is routine.

### Resource bounds

`src/shared/core/runtime-config.js` centralizes the DoS budgets: caps on peer-supplied data, peer-read timeouts, the identity-frame limiter (its burst scales with the topics a socket has proven) and the serve limiter. Each key has one row in `runtime-config-schema.js` with its default and, optionally, one of the six rules in `runtime-config-rules.js`.

- **Rules apply when a getter reads, not when config is built.** The live setters feed their own output back in, so `buildConfig` must stay a no-op on it.
- A budget that is multiplied by a count, or divided into elapsed time, is clamped finite and within bounds. A hand-edited `Infinity` or `0` therefore can't silently disable a lane.
- Most keys have no rule and are read raw. Adding a rule changes a DoS bound, so it needs a behaviour test.

---

## 17. Glossary

Holepunch stack terms (Bare, Hypercore/"core", Hyperbee/"bee", Hyperdrive, Corestore, Hyperswarm, Noise, Protomux) carry their upstream meanings; see [docs.pears.com](https://docs.pears.com). The worker runs on **Bare**, not Node.

- **Space**: a shared topic, and the unit of membership, discovery and sharing.
- **Loose file**: a file shared into a space individually. Peers download it explicitly; it never auto-syncs.
- **Share / owned folder**: a local directory tree an owner publishes into a space.
- **Foreign folder / mirror**: another member's share, materialized read-only to a local folder.
- **Mount**: the link between a share and a local disk path, on either side.
- **Share record**: the `share/<spaceId>/<shareId>` row in the owner's profile bee. It is tombstoned, never deleted (`src/shared/shares/shares.js`).
- **Catalog**: the owner's replicated, SCK-encrypted per-space bee of `file/<shareId>/<relPath>` rows. Loose files sit under `LOOSE_SHARE_ID` (`src/shared/shares/own-catalog.js`; peers read it through `src/shared/shares/peer-catalog.js`).
- **Registry**: the merged share records for a space, own plus every member's (`src/shared/shares/share-registry.js`).
- **Listing**: the display rows of one share (`src/shared/shares/share-listing.js`).
- **Catalog batch**: the buffered writer a bulk publish pass writes through (`src/shared/shares/catalog-writer.js`).
- **Overlay (backend)**: the content-addressed serve/fetch engine. Bytes come from holders' real files on disk.
- **Content hash / chunk map**: a file's whole-file hash and its per-chunk hash list. Both are computed at publish and verified at fetch.
- **M / KEK / SCK**: master secret, key-encryption key, space content key (§16).
- **Person / device / org key**: the principal tiers (§16).
- **Profile key**: the wire and bee spelling of the person key. It is the profile core's manifest hash, sent as `profileKey` on frames and stored as `publicKey` in rosters.
- **Identity binding**: the signature that ties a profile key to a socket's Noise key (§16).
- **Participation id**: a member's per-space, per-participation id, derived from M and `driveSuffix` and sent as `driveKey` (§3.5).
- **Membership grant**: the approval frame that carries the sealed SCK and the authenticated member-set root.
- **OR-Set / LWW / TOFU**: the add/remove set for member records; last-writer-wins for single-value records; trust on first use, held provisionally until authenticated.
- **Tombstone**: a record kept with `deletedAt`, so replicas can tell "removed" from "never seen".
- **Capability flag**: a `caps/<feature>` row in the profile bee. If it is absent, the peer doesn't publish that data; it does not mean the data is gone.
- **Presence lease**: a short-lived, re-announced liveness claim. When it expires, the peer counts as offline.
- **Hint / `event:reconcile`**: a coalesced worker → renderer signal meaning "this scope changed, refetch".
- **Audit tier**: the confidence recorded on each audit row. A is first-party. B is a peer action authenticated on the socket. C is derived from a peer's replicated bee, with a self-reported timestamp.
- **Partial**: an in-progress download, `*.mirall.part`, renamed atomically on completion. The suffix is defined in `src/shared/transfer/partial-suffix.js` and injected into the vendored engine. A plain `.part` would collide with browser downloads.
- **Pending transfer**: the persisted row for an unfinished download, which drives resume and the paused and error states.
- **Channel**: a release line (`dev` / `staging` / `prod`), each with its own update drive.

