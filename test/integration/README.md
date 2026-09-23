# Integration tests

Single-peer, in-process tests of the worker/shared **data layer** (`src/shared/*.js`), exercised against the real `bare-*` / Corestore / Hyperbee modules — no mocks of the storage engine, no networking.

- **Runner:** `npm run test:bare` → `test/bare-runner.mjs`, which runs each file in its **own** `brittle-bare` process, four at a time (`--jobs N` to change it). `bare` must be on `PATH` (`node_modules/bare-runtime/bin`). One file per process is what keeps a crash attributable: brittle's own `-j` is threads sharing one process, where one file's unhandled rejection aborts the run with no summary and no file name.
- **Deadlines scale.** A poll deadline, settle window or per-test `{ timeout }` passes through `scaled()` from `test/helpers/bare-timing.js`, so CI's `MIRALL_TEST_TIMEOUT_SCALE` reaches it; `scripts/ci/check-test-timing.sh` fails lint on one that does not. A budget passed into the code under test is part of the assertion and stays absolute.
- **What this layer is for:** correctness of a single peer's data operations — publish/reconcile, materialize, mount validation, catalog CRUD, storage accounting, share registry, pure predicates. Fast (per file ≈ seconds) and deterministic.

## The single-peer constraint (integration vs. flow)

`src/shared/*` modules are **process-global singletons** (one Store, one Profile, one Spaces bee per process), so a test process hosts exactly **one peer**. The harness (`test/helpers/store.js → freshPeer`) initialises that singleton stack against fresh temp dirs and a fake IPC.

Anything that needs **two or more peers** — replication, transfers between peers, membership convergence, witness corroboration — belongs at the **flow layer** (`test/flow/`, real worker subprocesses over a hermetic `hyperdht/testnet`). Some single-peer behaviour is faked into the integration layer via `setupSelfMirror`, which mounts a peer's own share back on itself as a "foreign" mirror so the materialize engine runs in-process (and `isOwnerOnline(self)` is `false`, which is what makes the offline-deletion guards observable). Genuine 3–4-peer scenarios live at the **flow** layer (see `test/flow/README.md`).

### Harness (`test/helpers/`)
- **`freshPeer(t)`** — clean single-peer stack (store, profile+identity, spaces, mounts, owned/foreign folders) wired to a fake IPC; returns `{ storage, downloads, fake, tmpDir }`. Auto-teardown.
- **`setupOwnedShare(t)`** — `freshPeer` + a space + an owned-folder share owned by this peer + its mount dir.
- **`setupSelfMirror(t, { files })`** — publishes a share with files and mounts it back on the same peer as a foreign mirror, so `applyChange` / `runMaterializeTick` run in-process.
- **`createFakeIpc()`** — records `emit`ted events so tests can assert on emitted status/update events.

---

## Existing tests

### A. Owned folders — publish & reconcile (owner side)
| File | Covers |
|------|--------|
| `owned-folder-publish.test.js` | `runPublishPass` (uploads, idempotent re-scan); **REGRESSION** mount-root-gone never deletes drive entries; unlink-while-root-gone drops the event; a genuine single-file delete propagates. |
| `owned-folder-edge.test.js` | **FIX-4** an unreadable file isn't deleted by reconcile; **FIX-5** an unlink for a path still present on disk (atomic save) doesn't delete. |
| `owned-concurrent-add.test.js` | A burst of concurrent `add`s in a new subfolder all publish; **FIX-WATCHER-MISS** a dropped watcher add is recovered by the catch-up reconcile. |
| `owned-fs-event.test.js` | `onFsEvent` add/change branch — republish-on-edit; hash short-circuit (unchanged = no-op); echo-guard skip (our own write doesn't loop); non-file / missing path and unreadable file are not published. |
| `ignore-matchers.test.js` | `shouldIgnore` / `DEFAULT_IGNORE` — basename and suffix matching, the three-pattern default list, what it deliberately no longer withholds; empty patterns ignore nothing; watcher and disk walk skip the same directory trees. |

### B. Foreign mirrors — materialize (peer side)
| File | Covers |
|------|--------|
| `owned-mount-fault.test.js` | **REGRESSION (FIX-PI12-1)** a pass whose publishes all failed on ENOSPC settles `paused-enospc`, not `active` (the scheduler counted `failed` and dropped it); EACCES → `paused-error` + the CODE; an unclassified item failure is not a mount fault; **REGRESSION (FIX-PI12-2)** a classified whole-pass failure records the code, never `err.message`, on the record or the wire; an unclassified one keeps its message; a root gone mid-pass settles `mount-point-gone` and records the absence; **REGRESSION (FIX-PI12-3)** a pass that declined to run does not consume a pending fault; `settleScanStatus`'s four outcomes each asserted; **CHARACTERISATION** a fault clears on the next clean pass with its cadence still armed, and a watcher item's fault is not lost between passes. |
| `foreign-del-guard.test.js` | **FIX-6** `shouldHonorDeletions` predicate — deletions honored only when owner online AND listing non-empty. |
| `foreign-toggle.test.js` | `setForeignEnabled` pause stops the tick + surfaces `paused`; resume restores `active` + materializes. |
| `foreign-prompt-materialize.test.js` | **FIX-MIRROR-PROMPT** a peer-drive change triggers a prompt tick (not the 30s poll); **FIX-MIRROR-ECHO** an owner edit within the echo-guard TTL still re-downloads. |
| `foreign-unmount.test.js` | **FIX-UNMOUNT-REFRESH** unmount emits `share-files-updated` so the file list refreshes. |

### C. Scan previews
| File | Covers |
|------|--------|
| `preview-scan.test.js` | `previewInitialPublishScan` upload/conflict counts + unchanged no-op; `previewMaterializeScan` download/conflict/existing counts; **REGRESSION** ignorable files (`.DS_Store`/`*.mirall.part`) excluded from the destination count. |

### D. Mount path validation
| File | Covers |
|------|--------|
| `mount-validate.test.js` | `validateMountPathSync` — system folders, nested (parent/child) overlap rejection, same-path owned↔owned **allowed** (one folder shared into multiple spaces), same-path overlap still rejected when a mirror is involved, foreign-inside-downloads, not-writable, cloud-sync rejection (`MOUNT_FORBIDDEN_CLOUD_SYNC`), no-advisory baseline. |
| `mount-validate-extra.test.js` | Rejects a mount inside the app-data (store) directory. |

### E. Loose files & transfers
| File | Covers |
|------|--------|
| `files-ops.test.js` | `addFile` refuses a source not saved on disk; `removeFile` unshares the catalog entry **and leaves the user's local source file untouched**; `markDownloaded` records the landed path (reveal/status); `discardPartial` unlinks the partial + clears the pending row. |
| `transfers-resolve-dest.test.js` | **FIX-3** `resolveDest` collision picker — never overwrites a pre-existing file or an in-flight `.mirall.part`; `name.ext → name (1).ext → name (2).ext`; extension-less + dotted-name handling. |
| `transfers-partials.test.js` | Pending-transfer row lifecycle (resume-stable dest, error set/clear, list/clear); `cleanupOrphanedPartials` sweeps unreferenced partials, keeps referenced + real files. |
| `list-files.test.js` | `listFiles` (single-peer slice): own loose files show as `mine` (owner "You"); files inside an owned-folder share prefix are excluded from the loose list; distinct files are each listed. (Cross-peer hash-dedup / status-priority is a flow concern.) |

### F. Shares registry
| File | Covers |
|------|--------|
| `share-registry.test.js` | `listSharesForSpace` returns own live shares (tagged `owner=me, source=own`) and omits tombstones; `[]` for an unknown space; `mountRootAvailable` dir/file/missing; `readPeerShareEntry` distinguishes live / tombstoned (`deletedAt`) / absent (`null`) shares. |

### G. Spaces & profile
| File | Covers |
|------|--------|
| `space-join-guard.test.js` | Re-joining the same invite topic is idempotent (one space, still pending); joining a space you created is a no-op. |
| `participation.test.js` | The participation id a space announces (`drive/<spaceId>`) derives from the record; a pending joiner and a space being left have none; a rejoin after a leave is a **new** participation; a create or grant whose announce fails leaves no half-joined space (the grant retries); a rejoin through an interrupted leave re-announces; the departure write retracts the id atomically and releases the profile bee on failure. |
| `retire-space-drives.test.js` | The computed keys equal the retired per-space drive's metadata and blobs keys (pinned against real Hyperdrive); the migration purges empty own drives and co-member replicas once, compacts only after clearing blocks, defers without M, and leaves an own drive holding blocks — which the leave path then deletes. |
| `profile-store.test.js` | `getProfile`/`setProfile` identity shape; name/avatar update; omitting avatar preserves it; identity key is stable across edits. |

### H. Storage hygiene
| File | Covers |
|------|--------|
| `cleanup-orphans.test.js` | **FIX-2** `cleanupOrphanedData` does not purge a replicated core it cannot classify (a peer drive's meta + blobs cores preserved). |
| `storage-info.test.js` | `getStorageInfo`'s index + database parts sum to the on-disk total, and sharing a file in place does not grow it by the file bytes. |

**FIX index:** FIX-2 (cleanup-orphans), FIX-3 (transfers-resolve-dest), FIX-4/FIX-5 (owned-folder-edge), FIX-6 (foreign-del-guard), FIX-MIRROR-PROMPT/FIX-MIRROR-ECHO (foreign-prompt-materialize), FIX-UNMOUNT-REFRESH (foreign-unmount), FIX-WATCHER-MISS (owned-concurrent-add).

---

## Gaps

The single-peer, integration-testable behaviour of the data layer is covered (groups A–I above). What is *not* covered here is, by design, out of this layer's reach — listed so the boundary is explicit:

- **Multi-peer convergence → `test/flow/`.** Replication, transfers between peers, cross-peer `listFiles` hash-dedup, 3–4-peer share visibility, multiple peers mirroring one folder, same-named folders from two owners, concurrent downloads. A test process is one peer, so none of these are reachable in this suite.
- **Pure path / string / predicate math → `test/unit/`.** Separator round-trips, share-prefix boundaries, the download collision walk, `shouldIgnore`, `shouldHonorDeletions`, system/reserved-path rejection, and cloud-sync detection live in `src/shared/folders/path-keys.js` (share-name validation in `src/shared/shares/shares.js`). The integration tests that touch the same logic — `mount-validate`, `transfers-resolve-dest`, `ignore-matchers`, `foreign-del-guard` — exercise it against a real drive/filesystem.

## Layering
Single-peer data-layer correctness lives here; replication / transfers / membership convergence go to `test/flow/`; pure platform/string math goes to `test/unit/`. Where an operation spans layers, its single-peer core is covered here and its convergence in flow.
