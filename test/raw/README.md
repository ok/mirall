# Raw holepunch tests

The lowest test tier: exercises the **holepunch primitives directly** — `Hyperdrive`, `Hyperbee`, `Corestore`, `Hyperswarm`, replicated over a hermetic `hyperdht/testnet` — with **no Mirall code** (`lib/*`, `src/shared/*`, the worker, IPC). No app, no mocks of the storage engine.

- **Runner:** `npm run test:node` (raw files run under `brittle-node` alongside `test/unit` and `test/flow`). `bare` must be on `PATH`. The raw suite alone: `npx brittle-node "test/raw/*.test.js"` (≈3.5s, exits clean).
- **What this layer is for:** it is the *trust-but-verify* layer for the dependencies the entire data layer is built on. Every flow/integration test assumes a pile of primitive behaviour — "a `del` replicates as a tombstone", "two keys with identical bytes don't double-store", "a reader that stays joined sees a *later* write" — without ever proving it. When a flow test goes red the question is always *"is it our wiring or did the primitive not do what we assumed?"* These tests pin down the second half so the flow layer can assume it, and so a holepunch dependency bump that changes a guarantee surfaces here, decoupled from our own code.
- **Boundary:** a raw test must call only holepunch APIs. The moment it imports `lib/*` or `src/shared/*`, it has moved up a layer (single-peer data-layer correctness → `test/integration`; multi-peer convergence → `test/flow`; pure path/string math → `test/unit`).

### Harness (`_holepunch.js`)
- **`setupPeer(testnet, label)`** — a `Corestore` + a `Hyperswarm` bound to the testnet bootstrap, replicating every connection into the store. Returns `{ dir, store, swarm }`. **`teardownPeer`** destroys/closes/removes.
- **`serve(peer, dk)`** — join a topic server-only and `flush`. **`consume(peer, dk)`** — join client-only with `findingPeers`. **`join(peer, dk)`** — join as both (for onward-seeding peers).
- **`eventually(fn, opts)`** — poll until `fn` returns a truthy value or the timeout; used to await live/late replication deterministically. **`patterned(size, seed)`** — deterministic multi-block byte payloads. **`sleep`**, **`tmpDir`**.

The canonical dance: writer `serve(...)`; reader builds a mirror core/drive from the writer's `key`, `consume(...)`, then `update({ wait: true })` before reading. Live/delete/move tests then keep the reader joined and re-`update()` inside `eventually` to observe writes made *after* the first sync.

---

## Scenarios

Each row names the file, the **primitive guarantee** it pins down, and the **user path** that rests on it. Two peers unless noted.

### A. Hyperdrive replication — files, live updates, deletes, moves
| File | Guarantee proven | User path it guards |
|------|------------------|---------------------|
| `holepunch-integration.test.js` › *hyperdrive…* | A single flat file `put` is retrievable byte-exact on a key-only reader after one `update`. | Sharing one file at all (baseline). |
| `live-update.test.js` *(CRIT-1)* | A reader that stays joined receives a **second** `put` made *after* its initial `update({wait:true})`, with no re-join. | Owner adds/edits a file while a peer is already mirroring — the steady state of every session. **Foundational: most rows below compose this.** |
| `del-replicates.test.js` *(CRIT-2)* | After `del`, the reader sees `entry → null` / `get → null` — a deletion propagates as an observable absence, not just "stops being served". | Deleting a file from a shared folder. |
| `nested-paths.test.js` *(CRIT-3)* | Nested keys (`/a/b/c.txt`) `put`/replicate identically to flat ones; `list(prefix,{recursive})` enumerates exactly the subtree on the reader. | Creating subfolders and dropping files into them (Hyperdrive has no real dirs — a folder is a key prefix). |
| `move-rename.test.js` *(CRIT-5)* | `del(old)` + `put(new)` converges so the reader ends with **only** the new path populated and the old gone. | Moving/renaming a file into a subfolder. |
| `subtree-delete.test.js` *(CRIT-6)* | `del`-ing every key under a prefix replicates each tombstone while keys outside the `/dir/` boundary (incl. the `/dirsibling.txt` near-miss) survive untouched. | Deleting a whole subfolder without over-deleting siblings — the worst data-loss class. |

### B. Blob / content layer — dedup, sparseness, streaming, reclaim
| File | Guarantee proven | User path it guards |
|------|------------------|---------------------|
| `blob-dedup.test.js` *(CRIT-4)* | **Characterization:** putting identical bytes at a second key **appends fresh blob blocks** — Hyperdrive does *not* content-dedup — yet both paths replicate byte-exact. | Copying a file inside a shared folder. **Decision-grade result: dedup is the app layer's job, not the primitive's.** |
| `sparse-download.test.js` *(CRIT-7)* | After a metadata-only `update`, no blob is cached; `get('/wanted')` downloads only that blob, leaving the un-requested one absent (`has` stays false). | Browsing a foreign folder and downloading one file on demand. |
| `blob-stream.test.js` *(CRIT-8)* | A multi-block blob (`blockLength > 1`) round-trips through `createWriteStream`/`createReadStream` in multiple chunks, byte-exact. | Transferring any real (multi-block) file. |
| `clear-reclaim.test.js` *(CRIT-13)* | `clear(path)` on a reader drops the cached blob: `has → false` and the underlying blob blocks (`blobs.core.has(blockOffset)`) are gone. | Unmounting a mirror and reclaiming its cached bytes (FIX-9). |

### C. Availability & multi-peer
| File | Guarantee proven | User path it guards |
|------|------------------|---------------------|
| `seeder-offline.test.js` *(CRIT-9)* | With metadata synced but the blob uncached, once the **sole seeder goes offline** a non-waiting `get` throws `BLOCK_NOT_AVAILABLE` (no silent success, no hang) and `has` stays false. | Requesting a file whose only owner is offline — the peer gets a clear unavailable signal, never wrong/empty bytes. *(See deferred note below for the resume-on-return half.)* |
| `multi-reader.test.js` *(CRIT-11, 3 peers)* | One writer's drive replicates to two independent readers; with the owner offline, a fresh third reader still obtains the file **onward-seeded** from the peer that cached it. | Two peers mirroring one folder; a late joiner served by an existing mirror. |
| `multi-core-mux.test.js` *(CRIT-12)* | A second drive opened from its `key` replicates over the **existing** connection without joining its discovery topic. | A space syncing the owner drive + several peer drives over the one connection the worker already holds. |

### D. Hyperbee key/value replication
| File | Guarantee proven | User path it guards |
|------|------------------|---------------------|
| `holepunch-integration.test.js` › *hyperbee…* | Two fresh `put`s replicate to a key-only reader. | The membership/registry/profile bees (baseline). |
| `bee-mutate.test.js` *(CRIT-10)* | A bee `del` and an **overwriting** `put` both replicate (reader reads `null` / the new value) — not first-write-wins. | Leaving a space, tombstoning a registry entry, editing a profile. |

### E. Corestore namespacing
| File | Guarantee proven | User path it guards |
|------|------------------|---------------------|
| `holepunch-integration.test.js` › *namespaced…* | Two `store.namespace(...)` drives get distinct keys and replicate independently. | One peer hosting an owned drive + many peer drives in one store. |

---

## Deferred / out of scope

- **CRIT-9, resume-on-return half.** The README originally scoped this as "unavailable while offline → *completes when the owner returns*." The unavailability half is proven deterministically here. The *return* half depends on Hyperswarm **reconnection** after a peer churns its swarm keypair, which is timing-dependent and too slow/flaky to assert at this layer (first-time discovery is fast; reconnection is not). The genuine "queue while owner offline → auto-resume" behaviour is owned by `test/flow/resume-transfer.test.js`, where it is exercised against the worker's queueing logic — exactly where it belongs.
- **Anything needing Mirall logic.** Publish/reconcile, materialize, the `shouldHonorDeletions` decision, collision naming — proven at integration/flow/unit, not here. This suite only characterizes the primitives underneath them.

## Layering
Primitive guarantees live here; single-peer data-layer correctness in `test/integration`; multi-peer convergence in `test/flow`; pure path/string math in `test/unit`.
