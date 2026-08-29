# Vendored: hyper-overlay v2 subset

This folder is a **vendored, in-tree snapshot** of the `lib/` source from the
upstream `hyper-overlay` project, reduced to the **v2 content-addressed serve/fetch**
path that Mirall's `overlay` content-backend builds on.

## Provenance

- **Upstream:** `hyper-overlay`
- **Snapshot copied from commit:** `6cac8ee5c184f7bb51f0daef3632301f6624c3a8` (v0.2.9)
- **Pin of record:** v0.2.10 (`815492f`). `0.2.9 → 0.2.10` is a lockfile/version-only
  bump — **no `lib/*` change** — so the bytes copied from `6cac8ee` are identical to the
  `815492f` `lib/` for every file vendored here. Re-diff against either with
  `git show <commit>:lib/<file>.js`.

## What was vendored (8 files — the import-closed v2 subset)

`overlay-v2.js` (facade entry) and its transitive imports:
`protocol-v2.js`, `chunk-scheduler.js`, `transfer.js`, `file-index.js`,
`sync-engine.js`, `chunker.js`, `messages-v2.js`.

These 8 form a **closed import graph** — no other upstream `lib/*` file is reachable
from `overlay-v2.js` along the v2 path.

## What was deliberately NOT vendored

- **v1 stack + orphans:** `index.js`, `chunk-registry.js`, `protocol.js`, `messages.js`,
  `http.js`, `fuse.js`, `pairing.js` (drops the `blind-pairing` dep), `watch-manager.js`
  (Mirall uses `chokidar`).
- **v2 files unreachable from the facade:** `pointer.js`, `manifest.js`, `tree.js`,
  `ignore.js` — they are **not imported** by the `overlay-v2.js → …` graph, so
  vendoring them would be dead code.
- The declared-but-unused `@hyperswarm/testnet` upstream dep is not brought along.

## Mirall vendor-time modifications

Each change is small, marked inline with a `[mirall]` comment, and keeps the snapshot
re-diffable against upstream. Categories:

1. **Subpath-import rewrite (resolution).** Upstream resolved Node/Bare builtins through a
   package `imports` map (`#fs`/`#path`/`#os`). Mirall has no such map and uses the Bare
   modules directly, so `#fs → bare-fs`, `#path → bare-path`, `#os → bare-os` in
   `overlay-v2.js`, `transfer.js`, `protocol-v2.js`. (Direct deps `compact-encoding`,
   `ready-resource`, `sodium-universal` added to `package.json` to match.)

2. **§4.1 — serve authorization hook (security).** `OverlayProtocolV2` and `HyperOverlayV2`
   gain `serveAuthorizer` + `localProfileKey` constructor opts. `protocol-v2._onContentRequest`
   calls `serveAuthorizer(peer, msg.from, contentHash)` **before** any path resolution or
   streaming; a deny is a **silent return** (observationally identical to "I don't hold it",
   so there is no membership oracle). `messages-v2.contentRequest` gains a trailing `from`
   (string) field; `requestContent` stamps `msg.from = localProfileKey`. The field is
   appended last, so a peer decoding without it reads `''`.

3. **§4.2 — fetch progress + re-seed control.** `HyperOverlayV2.fetchFile` forwards
   `opts.onProgress` into the scheduler and honours `opts.reSeed` (default `true`;
   callers that must not re-serve what they fetched pass `false` so a downloader
   holds nothing). `ChunkScheduler` now
   tracks cumulative bytes and calls `onProgress(receivedBytes, totalBytes)` per accepted
   chunk (upstream called it arg-less).

4. **§4.4 — diagnostics stripped.** All `console.log` and `[v2-diag]` instrumentation was
   removed from `protocol-v2.js` (the only file that had any). Nothing was rerouted to a
   logger — the vendored subset stays dependency-pure (npm deps + sibling vendor files only);
   any operator logging lives in the Mirall adapter/instance layer outside `vendor/`.

5. **§S1/§S2 — complete the serve gate (security).** The §4.1 authorizer covered only
   `_onContentRequest`, but the protocol has other serve/receive entry points. In "mirall
   mode" (a `serveAuthorizer` is configured), `protocol-v2.js` now also: records the synthetic
   serve-path a peer was authorized for (`peer.authorizedServe`) and serves `_onChunkNeed`
   bytes ONLY for those paths; refuses `_onFileRequest`, `_onFileOffer`, and `_onTreeRequest`
   (unused by Mirall, and ungated serve/metadata oracles); and refuses the legacy non-scheduler
   receive in `_onChunkHashes`/`_onChunkData` (which would let a peer overwrite the owner's
   source file via finalize-rename). Mirall's only legitimate flow — `contentRequest` →
   scheduler — is unaffected. All guards are `if (this._serveAuthorizer)`, so the raw upstream
   behavior is unchanged when no authorizer is set.

6. **§4.5 — opt-out of eager chunking in `registerFile`.** `HyperOverlayV2.registerFile`
   honours `meta.prepare` (default `true`); `false` skips the eager `this._transfer.prepareFile()`
   chunk-map build (a full second read of the file). The file is still servable — the in-memory
   path/content-hash maps are populated first, and `_onContentRequest` chunks lazily on a cache
   miss and caches it. The publish path (`makeServable`, both folder and loose) passes `false` so a
   publish doesn't read the whole file twice (once to hash, once to chunk); only `fetchFile`'s
   re-seed `registerFile` keeps the default (`true`) since a downloader that re-seeds serves immediately.

7. **§4.6 — visible, pausable/resumable/cancellable fetch.** A multi-source fetch can now be
   paused (keep the partial), resumed (continue it), and cancelled (discard the partial):
   - `TransferManager.startReceive` writes a **visible** partial (the upstream leading dot was
     dropped) so an in-progress download shows in the downloads folder rather than hiding.
     `PARTIAL_SUFFIX` is now exported. The suffix itself is no longer decided here — §4.17
     made it a host-injected constructor opt.
   - `startReceive` is **resume-aware**: a same-size existing partial is kept and each chunk is
     verified against the chunk list (content-addressed, so a stale/half-written chunk fails and
     is re-fetched); the recovered prefix seeds the whole-file hasher.
   - `TransferManager.pause(targetPath)` stops a transfer but keeps the partial (distinct from
     `cancel`, which unlinks it). `ChunkScheduler.onChunkHashes` requests only the missing chunks
     and seeds the byte counter; `ChunkScheduler.cancel()` stops the loop and rejects the fetch
     with `ECANCELLED`. `OverlayProtocolV2.cancelContent(hash, { discardPartial })` and
     `HyperOverlayV2.cancelFetch(hash, opts)` expose this; `fetchFile` rethrows `ECANCELLED`
     (alongside `EHASHMISMATCH`) so the caller treats a pause/cancel as not-a-failure.

8. **§4.7 — single-pass publish (eliminate the fetch-time chunk delay).** `TransferManager.prepareFile`
   now accepts `opts.onProgress` (fired per chunk during the streaming read) and returns the computed
   `contentHash` alongside `{ tier, chunks, size }`. `HyperOverlayV2.prepareForServe(diskPath, { onProgress })`
   uses it to build the content hash **and** the content-addressed chunk map in one read at publish time
   (the map is persisted by hash in `FileIndex`, durable across restarts). This SUPERSEDES the §4.6/§4.5
   intent of `prepare:false` for the publish path: that opt-out avoided reading the file twice *at publish*
   (hash, then chunk); doing both in one pass is strictly fewer reads (1 at publish vs. 1 at publish + 1 at
   first fetch) and removes the owner-side chunk-indexing stall the consumer saw before the first byte.
   `registerFile`'s `prepare:false` is still honored (the serve maps are populated without re-chunking, since
   the by-hash map already exists).

9. **§4.8 — cancellable-before-scheduler + same-hash join (`protocol-v2.js`).** `fetchContent`
   has an up-front window (the caller's peer-wait) where no `ChunkScheduler` exists yet, so a
   `cancelContent` in that window was a no-op. `OverlayProtocolV2` now keeps a `_cancelPending`
   set: `cancelContent` records the `content:<hash>` when no scheduler exists, and `fetchContent`
   cancels the scheduler the instant it creates one (→ `ECANCELLED`). `fetchContent` also DEDUPS
   by content hash: a concurrent fetch of the same hash JOINS the in-flight one (`sched.shared`)
   and copies the verified bytes to its own `destPath` instead of rejecting `already fetching`;
   a joiner whose leader was cancelled re-issues its own fetch. (`prepareForServe` also passes
   `byHashOnly` to `prepareFile` — see §4.7 — so the publish pass persists ONLY the
   content-addressed chunk map, not dead path-keyed state under the throwaway `/mir-prep` key.)

10. **§4.9 — cancellable publish (`transfer.js`/`overlay-v2.js`).** `prepareFile` accepts
    `opts.signal` (a plain `{ aborted }` object, matching the codebase's `walkDisk` pattern —
    `AbortController` is not a Bare global) and checks it each chunk, throwing `ECANCELLED` so a
    multi-GB publish hash can be stopped promptly (the streaming read is torn down on abort —
    §4.10 later replaced the read stream with `readFileBlocks`, whose `finally` closes the fd).
    `HyperOverlayV2.prepareForServe` threads `signal` through. The consumer
    (`loose-overlay.js#runLoosePublish`) registers a per-publish signal so a renderer Stop can
    abort the index, then tombstones/reverts the half-advertised catalog entry.

11. **§4.10 — block-read prepare + copy-free chunking (`transfer.js`/`chunker.js`, perf).** The
    publish read no longer uses `fs.createReadStream` (Bare hardcodes 64 KiB reads, which forced
    `chunkStream`'s `Buffer.concat` accumulator to re-copy its pending buffer per read — ~56×
    memcpy at tier 3). `prepareFile` now reads via a new module-level `readFileBlocks` async
    generator that yields blocks `>= tier maxSize` (host-adaptive size from `bare-os` `totalmem`,
    floored at `maxSize` so chunk boundaries are unchanged for any block size) and owns its fd
    (closed in a `finally`, which the consumer `for await`'s `.return()` runs on abort —
    replacing the old `reader.destroy()`). `prepareFile` consumes chunks with `chunkStream`'s new
    `copy:false` option (it hashes each chunk synchronously, so it needs no detached buffer), and
    guards `fileHasher.bytes === stat.size` before trusting the digest (a mid-read shrink would
    otherwise persist a hash no peer can reproduce). `chunkStream` gains `opts.copy` (default
    `true`, so all other callers are unchanged) and an opt-in, off-by-default `chunkStats` counter
    (`setChunkStats`/`resetChunkStats`/`chunkStats`) used only by tests + `scripts/bench-prepare.mjs`
    to validate the memcpy reduction. Chunk boundaries, chunk hashes, and the content hash are
    byte-identical to upstream for any block size (asserted across tiers in
    `test/unit/overlay-vendor-chunker.test.js`).

12. **§4.11 — chunk-map paging (`file-index.js`, fix).** Upstream persisted a file's whole
    chunk map as one Hyperbee value (`chunkmap:<path>` / `chunkmap-oid:<hash>`). For a very
    large file that value exceeds Hypercore's 15 MiB `MAX_SUGGESTED_BLOCK_SIZE` and the append
    throws `BAD_ARGUMENT` (a 1.1 TB file at tier 3 ≈ 1M entries ≈ ~120 MB), so `files:add`
    failed *after* the full prepare read. `FileIndex` now stores maps over `CHUNKS_PER_PAGE`
    (32768) entries as a `{ __paged: N }` header at the base key plus N `<base>\x00<i>` page
    values, written in one `Hyperbee.batch()` (atomic; stale pages from a previously-larger map
    at the same key are deleted in the same batch). The read assembles the pages and returns
    `null` if any is missing (a corrupt/incomplete paged value reads as a clean cache-miss so the
    caller re-chunks, never a silently truncated map). Small maps stay inline as a plain array —
    unchanged on disk and back-compatible with already-stored maps. `put/get/del` (path- and
    hash-keyed) and `delFile` route through private `_putPagedValue`/`_getPagedValue`/
    `_delPagedValue` helpers; the public API is unchanged, so `transfer.js`/`protocol-v2.js`/
    `overlay-v2.js` callers are untouched. `stats()` skips `\x00`-suffixed page keys. Covered by
    `test/integration/overlay-vendor-chunkmap-paging.test.js` (round-trip > 15 MiB, inline-small,
    rewrite-shrink, delete). Residual scaling limit left for a follow-up (not this fix): the map is
    still held whole in memory during prepare/serve. (The sibling wire-frame limit — shipping the
    whole array in one Protomux frame — is fixed in §4.12.)

13. **§4.12 — chunk-hashes wire paging (`messages-v2.js` + `protocol-v2.js` + `chunk-scheduler.js`,
    fix).** Upstream sends a file's whole chunk list in one `chunkHashes` Protomux frame. The Noise
    transport (`@hyperswarm/secret-stream`) length-prefixes each encrypted frame with a 24-bit
    integer, so its `MAX_ATOMIC_WRITE` is `256³-1` = 16 MiB-1 bytes; a larger frame throws *Message
    is too large for an atomic write* and the swarm drops the connection. A 1.25 TB file at tier 3
    (~1.2M entries × ~37 B/entry ≈ ~44 MB) tripped this on the holder the instant it answered a
    content-request — the requester then stalled at `0/N bytes` and timed out ("no holder"), with no
    byte ever sent. `chunkHashes` gains an appended `more` flag (uint8); `_sendChunkHashes` splits a
    list over `MAX_CHUNKS_PER_MSG` (100000 ≈ ~3.7 MB/frame, well under the limit even after
    Protomux's ≤8 MiB batching) into ordered pages (`more:1` … final `more:0`), and `_onChunkHashes`
    reassembles them per path via `_reassembleChunkHashes` before dispatching (the scheduler's
    no-progress watchdog is re-armed on each buffered page via `ChunkScheduler.notePageProgress`).
    Lists that fit one frame ship as one (`more:0`), byte-identical to upstream bar a trailing 0;
    `more` is appended last so a pre-paging peer omits it and the decoder reads `more:0` (back-compat
    for small files — a mixed-version swarm still transfers anything under one frame). Covered by
    `test/integration/overlay-vendor-chunkhashes-wire-paging.test.js` (red-first: a 1.25 TB-scale
    list exceeds `MAX_ATOMIC_WRITE` as one frame but every paged frame stays under it; round-trip
    reassembly; single-frame fast path) plus `chunkHashes` round-trip + back-compat cases in
    `test/unit/overlay-vendor-messages-v2.test.js`.

14. **§4.13 — vanish-during-read resilience (`transfer.js`/`overlay-v2.js`, fix).** Two
    unguarded `statSync` calls turned a routine "file moved out of a shared folder mid-scan"
    into a thrown `ENOENT` that aborted the whole reconcile (logged as *startup reconcile
    failed … stat "…"*). In `prepareFile` the post-read mtime-guard stat (`fs.statSync(filePath)`
    after the streaming read) now sits in a `try/catch → return null`, matching the pre-read
    stat and the existing mtime/size guards — the open fd keeps the read alive past a same-volume
    rename, so it is this path-resolving stat that trips, and a vanished source is simply
    re-queued. `HyperOverlayV2.registerFile`'s `fs.statSync(diskPath)` likewise returns `null`
    on a missing source — and its caller `makeServable` (Mirall code) now checks that return and
    skips `serveIndex.add` so the serve gate never advertises a hash the overlay has no path for
    (the fetch re-seed caller already ignored the return harmlessly under a `try/catch`).
    `protocol-v2.js#_onContentRequest` gains a matching `peer.authorizedServe.delete(syntheticPath)`
    on the serve-time `prepareFile`→null path (the vanish-during-read case now routes here),
    so `authorizedServe` stays in lockstep with `_filePaths`. Covered by regression tests in
    `test/integration/overlay-vendor-transfer.test.js`, `overlay-vendor-serve-chunkmap.test.js`,
    and `overlay-backend.test.js` (makeServable guard). (The folder-scan loop that aborted is
    hardened in `overlay-backend.js#overlayScan`, and the sibling loose boot-rehydrate loop in
    `loose-overlay.js#rehydrateLooseFiles` — both Mirall code, not vendored.)

15. **§4.14 — async + journaled resume (`transfer.js` + `chunk-scheduler.js` + `chunker.js`,
    fix).** Upstream `startReceive` re-verified a same-size partial with a synchronous
    `fs.readSync` + BLAKE2b loop over every chunk, plus a second synchronous readback in
    `_advanceHash`. On a large resumed download (a 600 GB partial = ~600k chunks) that froze the
    single Bare worker event loop for minutes, so no IPC frame was serviced (`setVerbose`,
    pause/cancel all hit the renderer's 30 s timeout) and the scheduler's idle watchdog — armed
    before the blocking call — self-tripped on unblock. `startReceive` is now `async` and
    cancellable: a same-size partial is resumed in O(1) from an app-private **receive journal**
    (`opts.journalDir`, a `journals/` dir keyed by a digest of the destination path — never in the
    user's downloads folder) holding the received-bitmap + a snapshot of the streaming whole-file
    hash (`createStreamingHasher` gains `snapshot()`/`{ restore }`, its libsodium state buffer being
    serializable; the journal is content-bound and `STATEBYTES`-tagged, so a mismatch/foreign build
    is ignored). When no valid journal exists (pre-upgrade partial, lost/edited journal) it falls
    back to `_recoverPartialAsync`, an async, yielding (`fs.read` + a `setTimeout(0)` every
    `VERIFY_YIELD_EVERY` chunks) re-verify that never blocks the loop and reports a 0..1 scan
    fraction via `opts.onVerifyProgress` (throttled to ≤101 integer-percent emits, surfaced as a
    "Verifying…" status). The whole-file digest is maintained by a single-flight **background hash
    pump** (`_advanceHash`/`_drainHash`): the contiguous run is fed to the hasher via async `fs.read`
    that yields, so a gap filling after a low-frontier resume can never block the loop the way the
    old synchronous `_advanceHash` did. `finalize` is `async` — it drains the pump, then reads the
    incremental digest with **no** trailing whole-file re-read. `pause` is `async` too: it drains the
    pump to the full contiguous frontier and writes a durable journal (`fsyncSync` the partial before
    the journal references it) so resume stays deterministically O(1). The periodic in-transfer flush
    is async, single-flight, time-throttled, and `fsync`s the partial before each journal write, so
    an ordinary power-loss can never leave the journal marking a chunk received whose bytes aren't
    durable. The received bitmap is kept incrementally on the transfer state (one bit per `writeChunk`)
    rather than rebuilt from the `received` set each flush. The journal is removed on
    finalize/cancel; orphans are swept by `cleanupOrphanedJournals(getJournalDir())`, wired into the
    worker boot beside the partial sweep. Cancel/discard cleanup (`overlay-download.js#discardPartial`)
    unlinks the partial + journal via the exported pure path helpers (`partialPathFor`/`journalNameFor`)
    independent of whether the overlay singleton is live. `ChunkScheduler.onChunkHashes` is now
    `async` — it suppresses the no-progress watchdog (including later seeders' re-arms via a
    `_settingUp` flag) until setup completes, threads an `onVerify` callback alongside `onProgress`,
    and honors a cancel during setup; the protocol dispatches it (and `onChunkData`) with a `.catch`
    so a fire-and-forget rejection can't escape. The integrity backstop against deliberate post-write
    editing of a journaled partial (a documented residual trust gap) is the manual re-verify primitive
    `_hashWholeFileAsync` (reuses `readFileBlocks`); surfacing it in the UI is a deferred follow-up.
    Covered by regression tests in `test/integration/overlay-vendor-transfer.test.js` (async vs blocking
    I/O, cancellable verify, O(1) snapshot resume + verified finalize, gap-fill does no sync readback,
    fresh-manager restart durability, non-binding-journal fallback, journal lifecycle +
    `cleanJournals`, the documented residual trust gap) and `test/unit/overlay-vendor-scheduler.test.js`
    (watchdog not charged against setup, second-seeder no re-arm, cancel during setup) +
    `test/unit/overlay-vendor-chunker.test.js` (snapshot/restore round-trip). The legacy single-peer
    `protocol-v2.js#_onChunkHashes` `startReceive`/`finalize` calls gain an `await` (gated off in
    Mirall by the serve authorizer). **Windows fix (read-only fsync):** the durable-flush paths
    (`_flushJournalSync`, `_drainFlush`) fsync the partial's persistent fd (pre-§4.16 `readFd`), which is opened
    `'r+'` (not `'r'`) because Windows `FlushFileBuffers` requires a write-capable handle — a read
    handle fails `EPERM`, and the fsync is now best-effort (its own `try`) so a failing fsync can
    never skip the journal write. Without this, no receive journal ever persisted on Windows and
    every resume fell back to the full async re-verify. Covered by a regression test in
    `test/integration/overlay-vendor-transfer.test.js` (mock fsync to throw → journal still
    persists + resumes O(1)).

16. **§4.15 — tree-response wire paging (`messages-v2.js` + `protocol-v2.js`, fix).** The sibling of
    §4.12 for the tree path: upstream sends a directory tree's whole entries array in one `treeResponse`
    Protomux frame, which overflows the Noise `MAX_ATOMIC_WRITE` (16 MiB-1) once a directory has enough
    entries — the same failure §4.12 fixed for `chunkHashes`. `treeResponse` gains an appended `more`
    flag (uint8) and `_sendTreeResponse` splits over `MAX_TREE_BYTES_PER_MSG` (4 MiB, byte-budgeted since
    tree entries are variable length) into ordered `more:1` … `more:0` pages. Because tree frames carry no
    correlation beyond the content hash, both `treeRequest` and `treeResponse` also gain an appended
    `nonce` (uint): the requester stamps a per-peer monotonic id, the holder echoes it on every page, and
    `_onTreeResponse` drops a page whose nonce doesn't match the in-flight request — so a stale page from a
    timed-out attempt can't settle a later same-hash retry (nonce 0 = a pre-nonce holder → unverifiable,
    best-effort). Pages accumulate in the request's own `pending` record (not a peer-wide hash-keyed map),
    bounded by `MAX_TREE_RESPONSE_BYTES` (rejects an endless stream instead of OOMing), and the idle timeout
    is re-armed per page (`_armTreeTimeout`); in-flight requests are rejected on channel close/destroy
    (`_failPendingTrees`). All fields are appended last, so a pre-paging peer omits them and the decoder
    reads 0 (back-compat). This path is dormant in Mirall (the serve authorizer refuses `_onTreeRequest`
    and nothing calls `requestTree`); the fix hardens the vendored library for any tree-enabled build.
    Covered by `test/integration/overlay-vendor-treeresponse-wire-paging.test.js` (red-first paging +
    reassembly, byte cap, stale-nonce drop, close rejection) plus `treeResponse`/`treeRequest` round-trip +
    back-compat cases in `test/unit/overlay-vendor-messages-v2.test.js`.

17. **§4.16 — persistent receive fd + in-memory in-order hashing (`transfer.js`, perf).** Two
    receiver-side changes, digest- and wire-identical (plan: `.claude/tasks/plan-download-cpu-b1-b2.md`).
    **B1:** `writeChunk` no longer opens+closes a fresh `'r+'` fd per chunk; the state's existing
    `'r+'` handle (renamed `readFd` → `fd`, now opened unconditionally rather than only when
    `meta.contentHash` is set) serves the positioned chunk writes, the hash pump's gap read-back, and
    the journal fsync. `fd == null` stays the pause/terminal sentinel; `_closeRead` became `_closeFd`
    and still runs before finalize's rename (Windows). A chunk landing after close is refused
    codeless (`transfer closed`) so the scheduler re-assigns instead of failing the fetch.
    **B2:** `writeChunk` stashes a copy of the just-verified chunk buffer in `state.memChunks`
    (copied because wire buffers are views into shared network slabs — udx read slab, decrypted
    in place by secret-stream; insert-refusal
    capped at `MEM_STASH_BYTES_DEFAULT` 16 MiB, `opts.memStashBytes` to override) and `_drainHash`
    consumes the stash at the frontier before falling back to `Buffer.alloc` + read-back — so fully
    in-order arrival feeds the whole-file hasher from memory with zero disk read-backs. The stash is
    never load-bearing (bytes hit disk before stashing; a miss reads back as before) and is skipped
    when the pump is mid-read on exactly that index (no double-feed) or the cap is hit. Per-transfer
    `state.stats = { readbacks, stashHits }` counts the paths for tests. Covered in
    `test/integration/overlay-vendor-transfer.test.js` (fd flat across a transfer + 20-transfer leak
    check, pause closes fd + codeless late-chunk refusal + journal resume, zero read-backs in-order,
    reverse-order stash + cap-0 forced read-back digest equality, duplicate-delivery idempotence,
    cancel clears fd + stash, EHASHMISMATCH unchanged).
    **Review hardening (same change-set; also touches `chunk-scheduler.js` + `protocol-v2.js`):**
    the chunk write loops on a SHORT `writeSync` count (libuv swallows an error after partial
    progress and returns short without throwing — retrying the remainder surfaces the real coded
    error instead of a silent hole the stash-fed digest cannot see); single-flight moved from
    `advancePromise` (cleared only on a microtask → stale gate during protomux's synchronous frame
    bursts) to a `state.draining` boolean set/cleared synchronously inside `_drainHash`, with a
    guarded `advancePromise` clear — same-macrotask frontier chunks now stash correctly and
    finalize/pause reduce to kick + await-to-quiescence; the pump yields by bytes hashed
    (`DRAIN_YIELD_BYTES` 2 MiB) since stash-fed iterations never await; fresh partials are
    created/truncated by the SAME `'w+'` open that becomes the persistent fd (one open, not two);
    finalize's rename failure carries `err.code` and clears `_active` (partial + journal stay for a
    resume-retry); `ChunkScheduler._fail` best-effort `pause()`s its destPath so a stalled/failed
    fetch parks no fd and no stash; the legacy `_onChunkHashes` receive wraps `startReceive` in
    try/catch so an fs throw drops that transfer instead of rejecting protomux's onmessage promise
    (which destroys the Noise stream) — that path stays gated off in Mirall by the serve authorizer.
    Additional coverage: short-write retry + stuck-write EIO, rename-failure code/cleanup/retry,
    scheduler `_fail` releases state (unit), stash accounting asserted pre-finalize (not after
    `_closeFd` zeroes it), duplicate gap-chunk single-count.

18. **§4.17 — host-injected partial suffix (`transfer.js` + `overlay-v2.js`).** The in-flight
    partial suffix is app policy, not engine policy: the app also probes for it (collision-free
    download naming), sweeps it at boot, and excludes it from publish via an ignore glob. With the
    value hardcoded here, those four sites could silently drift apart. `TransferManager` now takes
    `opts.partialSuffix` (`this._partialSuffix`, used by `startReceive` and `cleanPartials`), and
    `HyperOverlayV2` forwards `opts.partialSuffix` into it — the same pattern already used for
    `journalDir`. `PARTIAL_SUFFIX` / `partialPathFor` remain exported as the standalone default for
    an embedder that injects nothing, but they are **internal**: app code must never import them,
    because they are free of instance config and would desync from the injected value. Mirall
    defines the real suffix in `src/shared/transfer/partial-suffix.js` (`.mirall.part`) and injects
    it at `overlay-instance.js`. The import ban is enforced by a guard test
    (`test/unit/partial-suffix.test.js`); the opt itself is covered by
    `test/integration/partial-suffix-injection.test.js`.

19. **Host-injected bandwidth limiters (`overlay-v2.js` + `protocol-v2.js` + `chunk-scheduler.js` + `messages-v2.js`).**
    User-set transfer caps are enforced inside the serve/fetch engine, but the limiter itself lives
    in app code (`src/shared/transfer/bandwidth-limiter.js`) and is **injected** as
    `uploadLimiter` / `downloadLimiter` constructor opts, so `vendor/` gains no app imports and an
    embedder that injects nothing is unthrottled. `overlay-v2.js` forwards both to
    `OverlayProtocolV2`; `protocol-v2._onChunkNeed` awaits `uploadLimiter.take(bytes)` before each
    `chunkData.send` — and, because that wait opens a revocation window, re-checks the serve grant
    on the far side of it exactly as the existing drain boundary does. `protocol-v2.fetchContent`
    passes **`downloadLimiter.stream()`** — a per-scheduler handle, not the limiter itself — as the
    scheduler's `limiter` opt, and `_onChunkNeed` charges the upload cap against a **per-peer**
    `uploadLimiter.stream()` (`_uploadStreamFor`, detached in the channel's `onclose` so a serve
    loop parked on `take()` resolves 0 and hands its budget back instead of writing to a dead
    channel); `chunk-scheduler._assign` charges each chunk with `tryTake` and registers a
    retry with `whenAvailable(bytes, cb)` when gated. Time spent waiting on our own limiter is not
    silence, so a paced fetch must not be timed out — but the mechanism is watchdog SCOPING, not a
    re-arm while gated; see "Watchdog scoping" below for why the re-arm approach was removed.
    Covered by `test/unit/bandwidth-limiter.test.js` and the two download-cap cases in
    `test/unit/overlay-vendor-scheduler.test.js`.

    **One stream per scheduler (FIX-BW1).** The handle is not decoration: one bucket paces every
    concurrent transfer, so the bucket has to arbitrate. Passing the limiter directly made `tryTake`
    an unsynchronized grab, and a scheduler with chunks in flight re-enters `_assign` on *every*
    arrival — so it consumed each refill increment microseconds after it accrued, while a scheduler
    with nothing in flight could only retry on the shared timer and always found the bucket empty.
    Measured against that code: a 1 MB/s cap with three transfers gave the first 19.9 MB and the
    other two **exactly zero bytes**, indefinitely; the aggregate cap was honoured perfectly, only
    the split was wrong. The limiter now queues waiters, grants them credit in round-robin order,
    and refuses `tryTake` from the shared bucket while anyone is queued. `_assign` also **scans past**
    an unaffordable chunk (bounded by `GATED_SCAN_LIMIT`) instead of breaking, since chunk sizes vary
    4x within a tier and the head of `needed` must not block a smaller chunk behind it; and the three
    terminal paths (`_finish` / `_fail` / `cancel`) call `_detachLimiter()` so a grant that was never
    spent goes back to the bucket. Covered by `test/unit/bandwidth-fairness.test.js`, which drives
    three to five real schedulers through one real limiter — the case neither per-module suite could
    see, because each only ever exercised a single consumer.

    **Watchdog scoping (FIX-BW2 / FIX-BW4).** `_armIdleTimer` now arms only while something is
    outstanding with a peer — `_inflight` or `_requested` non-empty — and is additionally guarded on
    `_finalizing` (which `_done` does not cover: `_finalize` clears the timer precisely because the
    digest drain outlasts the window, and any re-arm during that await resurrects it and stall-fails
    a complete file). The re-arm on the gated assign was never sufficient on its own: it runs only
    when the limiter wakes the scheduler, and after an oversized chunk drives the bucket negative
    that wake is scheduled past the window (measured: an 8s wake against a 3s watchdog, transfer
    failed as "stalled"). The first attempt at this fixed it with a limiter *heartbeat* re-arming
    the watchdog on a timer — which made the watchdog never fire at all, so a peer wedging while
    still TCP-alive went undetected (measured: not caught after 6000ms against a 500ms window).
    Scoping is the correct axis: waiting on our own cap is not silence, and with nothing outstanding
    there is nobody to be silent. Note `MIN_BYTES_PER_SECOND` does NOT keep a chunk inside the
    window and never did — 32 KB/s x 30 s = 983,040 bytes, under the 1 MB tier-2 max chunk; the
    floor is a usability guard and its comment is corrected in both the worker and
    `NetworkSettings.tsx`. Covered by the FIX-BW2 and FIX-BW4 cases in `bandwidth-fairness.test.js`.

    **Peer rotation under a cap (FIX-BW5).** `_assign` rotates which holder it offers chunks to
    first (`_peerCursor`). Under a cap a round's budget is only a chunk or two, so a fixed starting
    peer takes all of it every round and multi-source fetch silently collapses to single-source
    (measured at a 2 MB/s cap: `A=38 / B=0 / C=0` chunk-needs). The peer loop also no longer breaks
    merely because the cap bit — only on a *structural* block, which `stream.wouldBlock()` reports
    (no credit and other streams queued, so no chunk of any size can be taken and scanning on is
    pure waste on the worker's single thread).

    **Refunds are summed (an efficiency, not a fix).** `removePeer` refunds its abandoned chunks
    through `_refundAll` in one call rather than one per chunk. This does NOT recover budget: `give`
    clamps the resulting total, and min(c, min(c, t+a)+b) equals min(c, t+a+b), so N calls credit
    exactly what one summed call credits (measured — an earlier revision of this note claimed
    otherwise and was wrong). The real limit is the clamp: a refund can never lift the bucket above
    one second of budget, so churn beyond that loses the excess either way.

    **Cross-peer keep-alive (FIX-BW9).** The upload cap is the mirror image of everything above:
    the holder waits on `take()` inside `_onChunkNeed`, nothing goes on the wire, and the
    DOWNLOADER — which cannot know a cap exists — reads the silence as a wedge. Past its 30s
    watchdog it aborts a transfer that is merely paced, and because the engine reads a code-less
    fetch failure as "holder gone" the row parks with no auto-resume trigger left to fire (the
    holder never disconnects). Measured before the fix, at a 2:1 chunk-cost-to-window ratio: one
    chunk delivered, then `multi-source fetch stalled`, and every subsequent resume bought about
    one more chunk. It trips when `chunkBytes x filesFromThatPeer x peersBeingServed >
    30s x uploadCap` — so the 32 KB/s cap FLOOR is already under the tier-2 max chunk (1 MB /
    30s = 34.1 KB/s), and even the 1 MB/s preset trips on a tier-3 share once `F x P >= 8`.

    The fix is a **keep-alive frame** (message 14, appended-last like slots 12/13 — protomux
    drops any id past a channel's registered message count, so older peers ignore it): the serve
    loop announces itself every `KEEPALIVE_INTERVAL_MS` while parked on the cap, naming the
    content hash and the chunk index it is paying for. `chunk-scheduler.notePeerAlive` re-arms the
    watchdog only if that peer currently owes us THAT chunk, and only within
    `KEEPALIVE_MAX_SILENCE_MS` (30 min) of the last VERIFIED progress — a hash-checked chunk or
    local setup completing, never a chunk list or a chunkHashes page, both of which any connected
    peer can send on a loop. Without all three properties this is FIX-BW4 again (a watchdog that
    never fires), because an unverifiable claim would otherwise let any peer hold a fetch open on
    zero bytes. The bound is sized from `chunkBytes x F x P / cap`, not from one chunk: 5 minutes
    (the first cut) covered only `F x P < 3` at the cap floor and would have re-broken the very
    transfers the fix rescues. The announcement is also gated on the serve grant still standing —
    it names a content hash, so continuing after a revocation hands the removed peer the
    membership oracle §16 exists to deny. Deliberately NOT fixed by raising
    `MIN_BYTES_PER_SECOND`: tier 3 would need a 136.5 KB/s floor, and `F x P` contention defeats
    any fixed floor. Covered by the FIX-BW9 cases in `test/unit/bandwidth-fairness.test.js` (the
    receiver gates) and `test/integration/overlay-vendor-backpressure.test.js` (the serve loop
    actually emitting them).

    **Transport liveness (FIX-BW10).** The same abort is reachable with no cap at all, on a path a
    keep-alive cannot reach. A serve loop parked on BACKPRESSURE puts nothing on the wire, and a
    single tier-3 chunk (4 MB) simply takes 33.6s to flush on a 1 Mbit/s wire — past the
    downloader's window with nothing stuck anywhere. A keep-alive answers neither: on a
    backpressured stream the frame queues behind the very data it is waiting on, and in the second
    case there is nothing to announce. The mismatch is that the watchdog is asked "is this peer
    dead?" but measures "has a chunk completed?" — the two diverge whenever ONE chunk outlives the
    window.

    The fix reads the downloader's own unforgeable signal: **bytes arriving from that peer**.
    `_onIdleExpiry` asks `_transportAlive()` before failing, and `protocol-v2` injects `peerBytes`
    (`_peerRxBytes`) reading `peer.mux.stream.rawStream.bytesReceived` — udx's native PER-PACKET
    counter — falling back to a TCP socket's `bytesRead` and then to secret-stream's
    `rawBytesRead`. The fallback order is load-bearing, not defensive: `rawBytesRead` advances per
    decrypted FRAME (`@hyperswarm/secret-stream` `_incoming()`), and a 4 MB chunk is ONE frame, so
    a frame-granular counter is frozen for exactly the window that has to be seen through.
    Measured on a shaped link: over the 2s a 4 MB frame spent in flight the packet counter
    advanced in all ten samples while `rawBytesRead` stayed at zero until the last packet landed.

    Four gates, each load-bearing, each proven by ablation in `bandwidth-fairness.test.js`:

    - **Only a peer holding chunks of ours may extend** — `_peerInflight > 0`, nothing wider. A
      peer merely in `_requested` is deliberately excluded: it may never answer at all (a peer
      that lacks the file and one whose serve gate denied us both return silently, §16), so its
      unrelated traffic on the shared mux would otherwise hand any connected peer an unbounded
      hold. Fast-failing that wait is what `_requested` exists for.
    - **The delivery floor is a RATE** — `MIN_LIVENESS_BYTES` per idle window, measured from a
      baseline (`_rxProbe`) re-taken only at expiry, so a window that ran long needs
      proportionally more. An idle connection is not silent: hyperdht's `connectionKeepAlive`
      (5 s) puts a 20-byte frame on the wire, measured at 360 B per 30 s window, so the 64 KiB
      floor sits ~180x above the noise and ~3x below the slowest delivery it protects.
    - **Reach is bounded** by `KEEPALIVE_MAX_SILENCE_MS` since the last VERIFIED progress,
      unchanged and shared with the keep-alive.
    - **The bytes must plausibly be OURS** — `ABANDON_FACTOR x owedBytes + ABANDON_SLACK_BYTES`
      since the debt anchor (`_rxAtOwe`, re-taken whenever the debt restarts), because every early
      return in `_onChunkNeed` (unreadable file, revoked grant, abandoned drain) leaves a holder
      looking exactly as busy as one mid-chunk. A peer with no anchor cannot be budgeted and
      therefore cannot extend.

    Without the floor a wedged-but-TCP-alive peer is never caught, which is FIX-BW4 again; without
    the budget a dropped batch holds the fetch to the 30-minute bound. The budget can only ever
    DECLINE an extension, so no path here fails later than the bound that already existed. Unlike
    FIX-BW9 this needs nothing from the holder — no frame, no version — so it also covers every
    peer already in the field.

    **The drain wait is progress-based, not a shorter deadline (FIX-BW10).** The obvious pairing
    for the above is to drop `DRAIN_TIMEOUT_MS` under the downloader's window, and it is wrong
    twice over: with the watchdog now extending on liveness the downloader no longer gives up at
    30s, so the ordering argument evaporates — and any budget short enough to catch a wedge is
    shorter than a legitimate flush (33.6s for one tier-3 chunk at 1 Mbit/s), so it would abandon
    batch tails on exactly the links this fix exists for, silently, with no re-request path on the
    receiver. `_waitForDrain` instead re-arms while `rawStream.bytesTransmitted` advances and
    abandons after `DRAIN_NO_PROGRESS_MS` (20s) with nothing leaving — the same
    liveness-not-outcome measure as the receive side. Where no TX counter exists the flat
    `DRAIN_TIMEOUT_MS` (60s, unchanged) stands, since slow and wedged are then indistinguishable.

    **Refund on abandonment.** `_assign` charges a chunk to the download limiter when it hands
    it to a peer, but the charge is for work that may never happen: `removePeer` returns the
    peer's in-flight chunks to `needed`, and a TRANSIENT write failure in `onChunkData` does the
    same. Both re-enter `_assign`, which charges the identical bytes again. `_refundAll(indices)`
    gives them back (`limiter.give`, capped at one second of budget like `refill`), so the
    achieved rate does not sink below the configured cap under peer churn — the limiter is a
    process-wide singleton, so leaked debt from one flapping fetch throttles every concurrent
    one. Covered by the refund cases in `test/unit/bandwidth-limiter.test.js`.

20. **Channel handshake actually reaches the wire (`messages-v2.js` + `protocol-v2.js` +
    `overlay-v2.js`, correctness).** `attach` called `channel.open({ version, capabilities })`
    but `createChannel` declared no `handshake` encoding, and protomux encodes a handshake only
    when one is declared (`index.js:104,113`) — so the version and capability bits were silently
    dropped and `_onOpen` never saw them. The channel had no negotiated version at all, and the
    `CAP_*` bits gated nothing.

    Declaring `messages.handshake` is the fix, but the encoding as it stood could not simply be
    declared: every build in the field (v1.8.0, v1.9.0) sends an open frame with **no** handshake
    bytes, protomux hands that empty tail straight to the decoder, and a throw there runs
    `_safeDestroy` on the whole mux — measured: with a strict decoder the socket AND its sibling
    `mirall/handshake` channel are destroyed on every `new to old` pairing. `handshake.decode` is
    therefore **total**: it bounds-checks every field and falls back to the exported
    `UNANNOUNCED_HANDSHAKE = { version: 1, capabilities: 0 }`, so neither an absent tail (an old
    build) nor a truncated one (garbage, or a hostile peer's one-byte frame — the channel id is
    the public protocol string, so any swarm peer can open it) can throw. Reading field-by-field
    also keeps the format append-only-extensible: a future peer that appends a third byte stays
    decodable by today's builds, which is the same cliff one release later. Version 1 is
    deliberate — every shipped build runs this same v2 message set, so "1" means "v2 messages, no
    announcement", and raising the minimum to 2 later retires exactly the unannounced builds.

    `_onOpen` records `peer.remoteVersion` / `peer.remoteCaps` and gates on `minVersion`
    (`MIN_VERSION = 1`, so nothing in the field is refused today); a peer below it loses **only
    its content channel** — the socket, its sibling control channel (`mirall/handshake`, or
    `mirall/content-hello` when the separate content plane is on) and corestore replication all
    stay up. A refused peer is also marked `peer.rejected`, and every `onmessage` is wrapped so
    frames the remote pipelined behind its open are dropped rather than dispatched: protomux
    drains them *after* `onopen` returns, against a record captured before our `close()`.
    `onPeerOpen` / `onPeerRejected` are constructor opts the app layer wires to its logger, so
    `vendor/` keeps no logger; both must be synchronous. `protocol-v2.js` also gained
    `export { VERSION, MIN_VERSION, CAP_LOCAL_FILES, CAP_ADAPTIVE_CHUNKS }` (upstream keeps all
    four module-private) purely so the tests can assert against the real constants. Rollout is a
    single phase: old peers need nothing, and the tolerant decode must ship in the same commit as
    the declaration. Covered by `test/unit/overlay-handshake.test.js` (the four-way pairing
    matrix against real protomux, a malformed-tail case, plus a wire-byte pin) and
    `test/integration/overlay-channel-handshake.test.js`.

## Re-diffing against upstream

```
git show 815492f:lib/overlay-v2.js | diff - overlay-v2.js   # (or 6cac8ee — identical)
```
The only expected hunks are the categories above.
