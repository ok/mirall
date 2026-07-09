# Flow tests (two-or-more-peer)

End-to-end **user-flow** tests: real worker subprocesses (the actual `workers/main.js` + `lib/*` data layer) wired together over a hermetic `hyperdht` testnet, exercised through the **same IPC the renderer uses**. This is the only layer that proves replication, transfers, mirror materialization, and membership convergence — anything that needs **two or more peers talking to each other**.

- **Runner:** `npm run test:node` (flow files run under `brittle-node` alongside `test/unit` and `test/raw`). `bare` must be on `PATH`.
- **Why a separate layer:** `src/shared/*` are process-global singletons, so a single test process hosts exactly one peer (see `test/integration/README.md`). Genuine peer-to-peer behaviour can only be observed by launching **independent worker subprocesses** — that is what this suite does.

### Harness (`test/helpers/`)
- **`localTestnet(t)`** — a hermetic `hyperdht` bootstrap; no real network.
- **`launchPeer(t, { bootstrap, displayName, storage, downloads })`** — boots a real worker as a `bare-sidecar` subprocess, sets a profile, returns a handle with `request(type, args)`, `waitFor(event, pred, ms)`, `until(type, args, pred, opts)`, `kill()`, plus `.downloads` / `.storage` dirs. Auto-teardown.
- **`connectInSpace(t, A, B, name?)`** — creates a space on A, joins it on B, awaits mutual membership; returns the deterministic `spaceId`.
- **`addPeerToSpace(owner, joiner, spaceId)`** — adds a further peer to an existing space (3+-peer flows); awaits mutual member-joined with `owner`.
- **`mkTmpDir` / `writeTmpFile` / `patternedBytes` / `waitForFile`** (`fixtures.js`) — temp dirs, deterministic byte payloads for byte-exact assertions, and a poll-until-present/absent helper for files a mirror materializes asynchronously.

Most folder tests inject `event:owned-folder-fs-event` (`add` / `change` / `unlink`) directly, standing in for the Electron-main watcher that does not run in this harness. A **move** is `unlink old + add new`; a **recursive folder delete** is one `unlink` per file — exactly what `chokidar` would emit.

---

## Existing scenarios

### A. Harness & connectivity foundation
| File | Scenario |
|------|----------|
| `_boot.test.js` | A worker boots under `bare-sidecar` and answers `ping`; two workers boot independently on one testnet (fresh peer has no spaces). |
| `membership.test.js` | Two peers converge on shared-space membership after the handshake; each sees the other as a member and online; `spaceId` is deterministic from the shared topic. |

### B. Loose-file sharing & transfers (single files, no folder)
| File | Scenario |
|------|----------|
| `loose-transfer.test.js` | A shares a file; B sees it as `remote`, downloads it (atomic rename, no `.partial`), bytes match end-to-end, status flips to `downloaded`. |

### C. Owned folders — publish & replication (owner side)
| File | Scenario |
|------|----------|
| `owned-folder.test.js` | A mounts a folder of pre-existing files; the initial scan publishes them; the share registry + file list replicate to B (correct name/owner/type); `share:delete` tombstones it and it vanishes from B. |
| `relocate.test.js` | Relocating an owned folder to an **identical** copy at a new path uploads/deletes **nothing** (no mirror churn) and re-points the mount; relocating to a **forbidden/system path** is rejected and the original mount is unchanged. |
| `nested-subfolders.test.js` | **CRIT-1:** a folder containing subfolders (`root.txt`, `sub/a.txt`, `sub/deep/b.bin`) publishes all three nested keys; the replicated listing preserves the `relPath`s; B's mirror recreates the directory tree byte-exact. The base case underpinning every other folder operation. |

### D. Foreign mirrors — materialization (peer side)
| File | Scenario |
|------|----------|
| `foreign-mirror.test.js` | B mirrors A's owned folder; with the owner online the blobs **stream on demand** and land byte-exact on B's disk, no leftover `.partial` (the connectivity-gate regression). |
| `foreign-sync.test.js` | **REGRESSION (connectivity gate):** a mirror **defers** while the owner is offline + blob uncached, then materializes when the owner returns. **REGRESSION (FIX-6):** with the owner online, an owner-side **edit** and **delete** both propagate; a file B already had in the mirror dir is left untouched. |
| `offline-delete-guard.test.js` | **CRIT-3 (FIX-6 negative, real flow):** once the owner goes offline, materialize ticks **never wipe** already-synced mirror files — the offline branch of `shouldHonorDeletions` proven across two workers (the dangerous data-loss path that was previously only faked in-process). |
| `mirror-local-edit.test.js` | **CRIT-7:** a mirror is owner-authoritative — if the user edits a file inside their own mirror, the next tick detects the hash mismatch and **re-downloads the owner's version**, reverting the local edit. |
| `remount-mirror.test.js` | **CRIT-11:** unmount reclaims the cache (FIX-9), and **mounting again re-materializes** the files (re-fetched from the owner, byte-exact) — the inverse of reclaim. |
| `share-delete.test.js` | Owner runs the full `owned-folder:delete` teardown: it vanishes from the owner's registry, the tombstone propagates and hides it on B, but B's already-mirrored files **orphan on disk (are not wiped)** — an emptied owner listing is the FIX-6 transient case. |

### E. Folder operations on a live mirror (owner edits → mirror converges)
| File | Scenario |
|------|----------|
| `mirror-add.test.js` | **CRIT-4:** a brand-new file added **after** the mirror is active — at the root and inside a fresh subfolder — materializes on the mirror byte-exact (fresh `add`, the most common ongoing action; `foreign-sync` only proved edit + delete). |
| `subfolder-delete.test.js` | **CRIT-2:** deleting a whole **subfolder** (its per-file `unlink`s) while the owner is online removes that subtree from the mirror and **leaves siblings outside it untouched** — the recursive-delete blast-radius guard. |
| `move-file.test.js` | **CRIT-5:** moving a file from the root into a subfolder (`unlink` old + `add` new) reaches the mirror as remove-old + create-new, byte-preserved, **no duplicate left at the old path**. |
| `copy-file.test.js` | **CRIT-6:** copying a file (two paths, identical bytes) replicates **both** as distinct drive entries and the mirror materializes both byte-identical from the shared content. |

### F. File-list status derivation
| File | Scenario |
|------|----------|
| `list-files-status.test.js` | `share:list-files` status badges: own files → `synced`; peer browse while owner online → `remote`; after on-demand download → `downloaded`; owner offline + uncached → `unavailable` (cached file stays `downloaded`); a mirrored file present on disk → `synced` with a `localPath` into the mirror. |

### G. Multi-peer (3+ peers)
| File | Scenario |
|------|----------|
| `multi-mirror.test.js` | **CRIT-8:** B **and** C both mirror the same owner folder; an owner edit and delete reach **both mirrors independently** (neither diverges). The suite's first multi-mirror scenario. |
| `concurrent-download.test.js` | **GAP #10:** three peers download the **same** file from one owner **at the same time**; the owner serves concurrent reads and each downloader finalises its own `.partial` to byte-exact content (no bookkeeping race / partial collision). |
| `same-name-folders.test.js` | **CRIT-9:** two owners each share a folder named "Docs"; a co-member sees them as **two distinct shares** (deduped by `owner:id`, not name), each with its own file list. *(Run as 2-peer — each owner is itself a member alongside the other — which is all the dedupe logic needs; see "Known limitation" below.)* |

### H. Membership lifecycle & leave
| File | Scenario |
|------|----------|
| `leave-reconcile.test.js` | When A leaves a shared space (broadcasts a leave frame + clears its own membership), B prunes A from its member list and online list while keeping the space and itself. |
| `leave-teardown.test.js` | **REGRESSION (FIX-1):** leaving a space tears down its folder machinery (owned mounts gone) **before** purging the drive, so no write-after-purge crash — the worker stays responsive. |

### I. Storage accounting
| File | Scenario |
|------|----------|

**FIX index:** FIX-1 (leave-teardown), FIX-6 (foreign-sync + share-delete + offline-delete-guard), FIX-9 (remount-mirror), connectivity-gate (foreign-mirror + foreign-sync).

---

## Gap analysis — what's covered and what remains

The folder-operation gaps the brief named — *sharing folders, creating subfolders, deleting files/folders, copying files, moving files into subfolders, deleting files in folders and subfolders* — are **now covered** end-to-end (groups C/D/E above), as are the first multi-peer scenarios (group G) and the storage-accounting gap (group I). The two structural facts that used to shape this list are no longer true: nested subfolders **are** exercised (`nested-subfolders` and every group-E test), and the suite **does** run three peers (`multi-mirror`, `concurrent-download`).

The pure platform/string math underneath all of it (separator mapping, prefix membership, collision walk, deletion-safety predicate, ignore globs) is unit-proven in `test/unit/path-keys.test.js`; these flow tests prove the I/O wiring and cross-peer convergence on top of it.

### Closed this pass
| Was | Now |
|-----|-----|
| CRIT-1 nested subfolders | `nested-subfolders.test.js` |
| CRIT-2 recursive subfolder delete (online) | `subfolder-delete.test.js` |
| CRIT-3 offline deletion guard (FIX-6 negative) | `offline-delete-guard.test.js` |
| CRIT-4 new file → active mirror | `mirror-add.test.js` |
| CRIT-5 move/rename into a subfolder | `move-file.test.js` |
| CRIT-6 copy a file | `copy-file.test.js` |
| CRIT-7 peer-side local edit of a mirror | `mirror-local-edit.test.js` |
| CRIT-8 two mirrors of one folder | `multi-mirror.test.js` |
| CRIT-9 two owners, same folder name | `same-name-folders.test.js` |
| CRIT-11 remount re-materializes | `remount-mirror.test.js` |
| #10 concurrent downloads of one file | `concurrent-download.test.js` |

### Still open
| # | Gap | Why it isn't covered yet | Peers |
|---|-----|--------------------------|-------|
| **MEM-1** | **Transitive membership propagation** — a peer that joins via one member learns the *inviter* reliably but **does not** learn the other existing co-members (observed: a third peer never converged on the second member within 120 s). This is why `same-name-folders` is framed as 2-peer and why a genuine *third-party observer* of two owners' shares can't be asserted today. | A real implementation gap, not a test gap — the same structural weakness `test/integration/README.md` flags as its biggest (#3 / witness-manifest propagation). Needs a fix in the membership manifest/handshake before a 3rd-party-visibility flow test can pass. | 3 |
| **CRIT-12** | **Re-seed on download → third-peer availability** — C fetches a file from B while the owner A is offline. | Feature **unbuilt** (`plan-reseed-on-download.md`, `plan-blind-peer-cloud-availability.md`); a downloader does not re-seed today. Add the 3-peer flow test when the feature lands. | 3 |
| **CRIT-13** | **Download rename-failure finalize branch** — the `.partial`→final rename fails (disk/permission fault). | Hard to induce: needs a live peer drive **and** an injected `fs.rename` fault inside the worker subprocess. The success path + `markDownloaded` landed-path are already covered (`loose-transfer` here, `files-ops` at integration). | 2 |

### Note on multi-peer convergence timing
Three- and four-worker tests on a single machine show non-deterministic catalog/membership convergence to the 3rd/4th peer: it usually lands in well under a second but can occasionally lag. The 3+-peer tests therefore gate on the **persisted** signal they actually depend on (`spaces:list` membership, or `event:files-updated`) with generous `until` windows rather than fixed sleeps. If a 3-peer test flakes, it's convergence latency — widen the window, don't assume a logic bug.
