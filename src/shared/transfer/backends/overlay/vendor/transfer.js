/**
 * TransferManager — On-demand chunking and streaming file transfer
 *
 * Sender side:
 *   1. Read file from disk
 *   2. Chunk on demand (adaptive FastCDC)
 *   3. Send chunk hashes → peer says which it needs → stream those chunks
 *   4. Release chunks from memory after send
 *
 * Receiver side:
 *   1. Receive chunk hashes, respond with which are missing
 *   2. Receive chunks, write to <file> + the configured partial suffix
 *   3. Verify each chunk hash
 *   4. Atomic rename on completion
 *
 * No blob storage. Chunks exist in memory during transfer only.
 */

import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import c from 'compact-encoding'
import sodium from 'sodium-universal'
import { chunk as chunkBuffer, chunkStream, hashChunk, createStreamingHasher, selectTier, getTierParams } from './chunker.js'

// [mirall] §4.17 — INTERNAL upstream default only. Mirall injects its own suffix via
// the `partialSuffix` constructor opt and defines the real value in
// `src/shared/transfer/partial-suffix.js`. Neither export below may be imported by app
// code: they are free of instance config, so reading them while a different suffix is
// injected would silently desync. A guard test enforces that.
export const PARTIAL_SUFFIX = '.overlay-partial'

export const partialPathFor = (targetPath) => path.join(path.dirname(targetPath), path.basename(targetPath) + PARTIAL_SUFFIX)

// Resume verification + whole-file hashing run async + yielding so a multi-GB pass
// never blocks the worker event loop (IPC, pause/cancel, progress stay live).
const VERIFY_YIELD_EVERY = 64
const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0))

// [mirall][B1] Own-fd accounting. The leak tests cannot use the process fd table
// (/proc/self/fd, /dev/fd) as their oracle: `brittle-bare -j` runs test files as threads
// inside ONE process, so sibling files' descriptors pollute any snapshot of it — a run
// once measured a *negative* delta, which a single test's own fds cannot produce. Route
// every open/close in this module through these wrappers so the tests can assert on the
// descriptors this module actually owns, which is the invariant they mean.
// A close that throws leaves the fd open, so it must not decrement.
let openFds = 0

export const openFdCount = () => openFds

async function openTracked (filePath, flags) {
  const fd = await fs.open(filePath, flags)
  openFds++
  return fd
}

function openSyncTracked (filePath, flags) {
  const fd = fs.openSync(filePath, flags)
  openFds++
  return fd
}

async function closeTracked (fd) {
  try { await fs.close(fd) } catch { return }
  openFds--
}

function closeSyncTracked (fd) {
  try { fs.closeSync(fd) } catch { return }
  openFds--
}

// Receive journal: bitmap + whole-file hash snapshot, stored in app-private storage
// (opts.journalDir) keyed by a digest of the destination path — never next to the
// download — so resume is O(1) and the incremental verify continues with no re-read.
const JOURNAL_SUFFIX = '.journal'
const JOURNAL_MAGIC = 0x4d4a5633
const JOURNAL_FLUSH_EVERY = 512
const JOURNAL_FLUSH_INTERVAL_MS = 1500
export const journalNameFor = (targetPath) => hashChunk(Buffer.from(targetPath)) + JOURNAL_SUFFIX

// [mirall] §4.10 block-read prepare (see PROVENANCE.md) — host-adaptive read block.
const READ_BLOCK_DEFAULT = 8 * 1024 * 1024
const READ_BLOCK_LOW_RAM = 4 * 1024 * 1024
const LOW_RAM_THRESHOLD = 6 * 1024 * 1024 * 1024

// [mirall][B2] Cap on stashed just-received chunk buffers (per transfer, insert-refusal),
// and the hash pump's yield budget — stash-fed iterations never await, so the pump
// yields by bytes hashed, not chunk count.
const MEM_STASH_BYTES_DEFAULT = 16 * 1024 * 1024
const DRAIN_YIELD_BYTES = 2 * 1024 * 1024

// [mirall] §4.10 Emit file blocks >= tier maxSize so chunkStream drains every block
// instead of re-copying a growing pending buffer (64 KiB createReadStream reads force
// ~56x memcpy at tier 3). Owns its fd and closes it on every terminal path: normal
// end, consumer break/throw (for-await calls .return() → finally), read error.
async function * readFileBlocks (filePath, size, blockSize) {
  const fd = await openTracked(filePath, 'r')
  try {
    let pos = 0
    while (pos < size) {
      const want = Math.min(blockSize, size - pos)
      const buf = Buffer.allocUnsafe(want)
      let filled = 0
      while (filled < want) {
        const n = await fs.read(fd, buf, filled, want - filled, pos + filled)
        if (n <= 0) break
        filled += n
      }
      if (filled === 0) break
      pos += filled
      yield filled === buf.length ? buf : buf.subarray(0, filled)
    }
  } finally {
    await closeTracked(fd)
  }
}

function bitmapOf (received, total) {
  const bm = Buffer.alloc((total + 7) >> 3)
  for (const i of received) bm[i >> 3] |= 1 << (i & 7)
  return bm
}

// Drop journals whose partial is gone, are stale, or are corrupt/foreign. Each
// journal self-describes its partial path (read cheaply from the header). Standalone
// (no TransferManager instance) so a worker-boot sweep can reclaim orphans without
// the overlay stack being live.
export function cleanupOrphanedJournals (journalDir, maxAge = 7 * 86400000) {
  const cleaned = []
  if (!journalDir) return cleaned
  let entries
  try { entries = fs.readdirSync(journalDir) } catch { return cleaned }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.endsWith(JOURNAL_SUFFIX)) continue
    const full = path.join(journalDir, entry)
    let remove = false
    try {
      const raw = fs.readFileSync(full)
      const s = { start: 0, end: raw.length, buffer: raw }
      if (c.uint32.decode(s) !== JOURNAL_MAGIC) remove = true
      else {
        c.uint32.decode(s)
        const partialPath = c.string.decode(s)
        if (!fs.existsSync(partialPath)) remove = true
        else if (now - fs.statSync(full).mtimeMs > maxAge) remove = true
      }
    } catch { remove = true }
    if (remove) { try { fs.unlinkSync(full); cleaned.push(full) } catch {} }
  }
  return cleaned
}

export class TransferManager {
  constructor (fileIndex, opts = {}) {
    this._fileIndex = fileIndex
    this._maxConcurrency = opts.maxConcurrency || 4
    this._active = new Map() // path → transfer state
    this._memStashBytes = opts.memStashBytes ?? MEM_STASH_BYTES_DEFAULT
    this._journalDir = opts.journalDir || null
    // [mirall] §4.17 — the host owns the partial suffix; PARTIAL_SUFFIX is only the
    // standalone default for an embedder that passes nothing.
    this._partialSuffix = opts.partialSuffix || PARTIAL_SUFFIX
    if (this._journalDir) { try { fs.mkdirSync(this._journalDir, { recursive: true }) } catch {} }
  }

  _journalPathFor (targetPath) {
    if (!this._journalDir) return null
    return path.join(this._journalDir, journalNameFor(targetPath))
  }

  // ── Sender side ─────────────────────────────────────────────

  /**
   * Prepare a file for sending — read from disk, chunk, return hashes.
   * Chunk map is persisted for large files (>1MB).
   *
   * @param {string} filePath - absolute path on disk
   * @param {string} overlayPath - path in the overlay namespace
   * @returns {{ tier: number, chunks: Array<{ hash, offset, length }>, size: number } | null}
   */
  async prepareFile (filePath, overlayPath, opts = {}) {
    // Check file exists and get stats
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch {
      return null
    }

    if (!stat.isFile()) return null

    const mtimeBefore = stat.mtimeMs

    // Check for existing chunk map (skip re-chunking if valid)
    const existing = await this._fileIndex.getChunkMap(overlayPath)
    const fileMeta = await this._fileIndex.getFile(overlayPath)

    if (existing && fileMeta && fileMeta.mtime === mtimeBefore) {
      // Chunk map still valid — file hasn't changed.
      // [mirall] Backfill the content-addressed alias so the serve path (a
      // different overlay key) reuses this map instead of re-reading the file —
      // covers maps chunked before content-addressed caching existed.
      if (fileMeta.contentHash && stat.size >= 1048576 && !await this._fileIndex.hasChunkMapByHash(fileMeta.contentHash)) {
        await this._fileIndex.putChunkMapByHash(fileMeta.contentHash, existing)
      }
      return {
        tier: selectTier(stat.size),
        chunks: existing,
        size: stat.size,
        contentHash: fileMeta.contentHash // [mirall] surfaced so the publish path gets the hash from one pass
      }
    }

    // [mirall] §4.10 Read in blocks >= tier maxSize and chunk from views (copy:false).
    // Cut points are content-stable across block sizes, so peers still match hashes.
    // size is passed to the hasher so the streaming digest matches hashChunk(buffer).
    const tier = selectTier(stat.size)
    const blockSize = Math.max(
      getTierParams(tier).maxSize,
      os.totalmem() < LOW_RAM_THRESHOLD ? READ_BLOCK_LOW_RAM : READ_BLOCK_DEFAULT
    )
    const fileHasher = createStreamingHasher({ size: stat.size })
    const chunks = []

    for await (const c of chunkStream(readFileBlocks(filePath, stat.size, blockSize), { tier, copy: false })) {
      // honor a publish-cancel signal (per-chunk granularity); on throw the
      // for-await calls readFileBlocks.return() which closes the fd.
      if (opts.signal?.aborted) { const e = new Error('publish aborted'); e.code = 'ECANCELLED'; throw e }
      fileHasher.update(c.data)
      chunks.push({ hash: c.hash, offset: c.offset, length: c.length })
      opts.onProgress?.(c.length)
    }

    // mtime guard — abort if file changed during the streaming read. [mirall] A
    // vanished source (moved out of the folder mid-read) is just another "changed
    // during read" case — the open fd kept the read alive after a same-volume
    // rename, so it is this path-resolving stat that trips ENOENT. Guard it like
    // the pre-read stat above and re-queue rather than throw.
    let statAfter
    try {
      statAfter = fs.statSync(filePath)
    } catch {
      return null // source vanished during read, caller should re-queue
    }
    if (statAfter.mtimeMs !== mtimeBefore) {
      return null // file changed during read, caller should re-queue
    }

    // [mirall] §4.10 guard: a mid-read shrink can feed the digest fewer bytes than the
    // size baked into its leaf prefix — re-queue instead of persisting a bad hash.
    if (fileHasher.bytes !== stat.size) return null

    // Update file index
    const contentHash = fileHasher.digest()

    // Persist chunk map for large files — both path-keyed (legacy serve lookups)
    // and content-addressed ([mirall], so the serve path reuses it across keys).
    // [mirall] byHashOnly (the publish prepareForServe pass) keeps ONLY the
    // content-addressed map — the serve path resolves by hash, so the path-keyed map
    // + putFile under a throwaway overlay key would be dead, never-read state.
    if (stat.size >= 1048576) {
      if (!opts.byHashOnly) await this._fileIndex.putChunkMap(overlayPath, chunks)
      if (!await this._fileIndex.hasChunkMapByHash(contentHash)) await this._fileIndex.putChunkMapByHash(contentHash, chunks)
    }

    if (!opts.byHashOnly) {
      await this._fileIndex.putFile(overlayPath, {
        contentHash,
        size: stat.size,
        mtime: mtimeBefore
      })
    }

    return { tier, chunks, size: stat.size, contentHash }
  }

  /**
   * Read a specific chunk from disk by its offset and length.
   * Returns raw bytes — caller sends them to the peer.
   *
   * @param {string} filePath - absolute path on disk
   * @param {number} offset - byte offset
   * @param {number} length - bytes to read
   * @returns {Buffer | null}
   */
  readChunk (filePath, offset, length) {
    try {
      const fd = openSyncTracked(filePath, 'r')
      const buf = Buffer.alloc(length)
      const bytesRead = fs.readSync(fd, buf, 0, length, offset)
      closeSyncTracked(fd)
      if (bytesRead !== length) return null
      return buf
    } catch {
      return null
    }
  }

  /**
   * Determine which chunks a peer needs (chunks they don't already have).
   *
   * @param {Array<{ hash, offset, length }>} offered - chunks the sender has
   * @param {Set<string>} peerHas - set of chunk hashes the peer already has
   * @returns {number[]} indices of chunks the peer needs
   */
  computeNeeded (offered, peerHas) {
    const needed = []
    for (let i = 0; i < offered.length; i++) {
      if (!peerHas.has(offered[i].hash)) {
        needed.push(i)
      }
    }
    return needed
  }

  // ── Receiver side ───────────────────────────────────────────

  // Start receiving a file. A same-size partial is resumed: the journal restores the
  // received-set + whole-file hash snapshot in O(1) (no re-read); failing that, an
  // async, yielding re-verify rebuilds them without blocking the event loop.
  // opts.isCancelled aborts a long re-verify; opts.onVerifyProgress(0..1) drives the UI.
  async startReceive (targetPath, meta, opts = {}) {
    const isCancelled = opts.isCancelled || (() => false)
    const dir = path.dirname(targetPath)
    const base = path.basename(targetPath)
    // Visible partial (no leading dot) so an in-progress download shows in the
    // downloads folder. [mirall] §4.17 — suffix comes from the host.
    const partialPath = path.join(dir, base + this._partialSuffix)
    const journalPath = this._journalPathFor(targetPath)

    fs.mkdirSync(dir, { recursive: true })

    let resumed = false
    try { resumed = fs.statSync(partialPath).size === meta.size } catch {}

    let received = new Set()
    let hasher = meta.contentHash ? createStreamingHasher({ size: meta.size }) : null
    let hashFrontier = 0

    if (resumed) {
      const j = journalPath ? this._loadJournal(journalPath, partialPath, meta) : null
      if (j) {
        received = j.received
        hashFrontier = j.hashFrontier
        if (meta.contentHash) hasher = createStreamingHasher({ size: meta.size, restore: { state: j.hasherState, bytes: j.hasherBytes } })
      } else {
        const rec = await this._recoverPartialAsync(partialPath, meta, isCancelled, opts.onVerifyProgress)
        received = rec.received; hasher = rec.hasher; hashFrontier = rec.hashFrontier
      }
    } else {
      if (journalPath) { try { fs.unlinkSync(journalPath) } catch {} }
    }

    if (isCancelled()) { const e = new Error('receive cancelled during setup'); e.code = 'ECANCELLED'; throw e }

    // [mirall][B1] ONE persistent fd for the whole transfer — positioned
    // writeSync/fs.read never move a shared cursor, so a single handle serves the
    // chunk writes, the hash pump's gap read-back, and the journal fsync. Replaces
    // an openSync+closeSync per chunk; 'w+' creates+truncates the fresh partial in
    // the same open.
    const fd = openSyncTracked(partialPath, resumed ? 'r+' : 'w+')
    if (!resumed) {
      try { fs.ftruncateSync(fd, meta.size) } catch (err) { closeSyncTracked(fd); throw err }
    }

    const total = meta.chunks.length
    const state = {
      partialPath,
      targetPath,
      journalPath,
      chunks: meta.chunks,
      received,
      bitmap: bitmapOf(received, total),
      total,
      size: meta.size,
      contentHash: meta.contentHash || null,
      hasher,
      hashFrontier,
      advancePromise: null,
      draining: false,
      sinceFlush: 0,
      lastFlush: 0,
      flushing: false,
      flushPending: false,
      fd,
      // [mirall][B2] Bounded stash of just-received verified chunk buffers so the
      // hash pump feeds from memory instead of reading the bytes back off disk.
      // Never load-bearing: bytes hit disk first; a miss falls back to read-back.
      memChunks: new Map(),
      memBytes: 0,
      stats: { readbacks: 0, stashHits: 0 }
    }

    // [mirall] A prior transfer for this path that ended via _fail (stall / all-peers-
    // gone / disk error) leaves its state here with an open fd — close it before
    // overwriting so a retry/resume of the same file can't orphan the fd.
    const prev = this._active.get(targetPath)
    if (prev) this._closeFd(prev)

    this._active.set(targetPath, state)
    // A fresh transfer has nothing worth journaling yet; a resume that recovered
    // chunks persists them now so an immediate re-pause is O(1).
    if (received.size > 0) this._flushJournal(state)
    return state
  }

  // Rebuild the received-set from a same-size partial without blocking the loop:
  // async reads, a yield every VERIFY_YIELD_EVERY chunks, feeding the contiguous
  // prefix into the whole-file hasher inline (single pass, no second read).
  async _recoverPartialAsync (partialPath, meta, isCancelled, onVerifyProgress) {
    const received = new Set()
    const hasher = meta.contentHash ? createStreamingHasher({ size: meta.size }) : null
    let hashFrontier = 0
    const total = meta.chunks.length
    const maxLen = meta.chunks.reduce((m, c) => (c.length > m ? c.length : m), 0)
    const buf = Buffer.allocUnsafe(maxLen)
    let lastPct = -1
    onVerifyProgress?.(0)
    const fd = await openTracked(partialPath, 'r')
    try {
      for (let i = 0; i < total; i++) {
        if (isCancelled()) { const e = new Error('receive recovery cancelled'); e.code = 'ECANCELLED'; throw e }
        const ci = meta.chunks[i]
        let n = 0
        try { n = await fs.read(fd, buf, 0, ci.length, ci.offset) } catch {}
        const view = buf.subarray(0, ci.length)
        if (n === ci.length && hashChunk(view) === ci.hash) {
          received.add(i)
          if (hasher && i === hashFrontier) { hasher.update(view); hashFrontier++ }
        }
        if ((i & (VERIFY_YIELD_EVERY - 1)) === VERIFY_YIELD_EVERY - 1) {
          const pct = Math.floor(((i + 1) / total) * 100)
          if (pct !== lastPct) { lastPct = pct; onVerifyProgress?.(pct / 100) }
          await yieldToLoop()
        }
      }
    } finally {
      await closeTracked(fd)
    }
    onVerifyProgress?.(1)
    return { received, hasher, hashFrontier }
  }

  _encodeJournal (state) {
    const total = state.total
    const bm = state.bitmap
    const ch = state.contentHash ? Buffer.from(state.contentHash, 'hex') : Buffer.alloc(32)
    const snap = state.hasher ? state.hasher.snapshot() : { state: Buffer.alloc(0), bytes: 0 }
    const s = { start: 0, end: 0, buffer: null }
    c.uint32.preencode(s, JOURNAL_MAGIC)
    c.uint32.preencode(s, sodium.crypto_generichash_STATEBYTES)
    c.string.preencode(s, state.partialPath)
    c.uint64.preencode(s, state.size)
    c.uint32.preencode(s, total)
    c.fixed32.preencode(s, ch)
    c.uint32.preencode(s, state.hashFrontier)
    c.uint64.preencode(s, snap.bytes)
    c.buffer.preencode(s, snap.state)
    c.buffer.preencode(s, bm)
    s.buffer = Buffer.allocUnsafe(s.end)
    c.uint32.encode(s, JOURNAL_MAGIC)
    c.uint32.encode(s, sodium.crypto_generichash_STATEBYTES)
    c.string.encode(s, state.partialPath)
    c.uint64.encode(s, state.size)
    c.uint32.encode(s, total)
    c.fixed32.encode(s, ch)
    c.uint32.encode(s, state.hashFrontier)
    c.uint64.encode(s, snap.bytes)
    c.buffer.encode(s, snap.state)
    c.buffer.encode(s, bm)
    return s.buffer
  }

  // Returns the resume state only when the journal is for this partial, binds to
  // this content, and its snapshot is restorable on this libsodium build; else null
  // so the caller falls back to the async re-verify.
  _loadJournal (journalPath, partialPath, meta) {
    let raw
    try { raw = fs.readFileSync(journalPath) } catch { return null }
    try {
      const s = { start: 0, end: raw.length, buffer: raw }
      if (c.uint32.decode(s) !== JOURNAL_MAGIC) return null
      const stateBytes = c.uint32.decode(s)
      const storedPartial = c.string.decode(s)
      const size = c.uint64.decode(s)
      const total = c.uint32.decode(s)
      const ch = c.fixed32.decode(s).toString('hex')
      const hashFrontier = c.uint32.decode(s)
      const hasherBytes = c.uint64.decode(s)
      const hasherState = c.buffer.decode(s)
      const bm = c.buffer.decode(s)
      if (storedPartial !== partialPath) return null
      if (size !== meta.size || total !== meta.chunks.length) return null
      if (meta.contentHash && ch !== meta.contentHash) return null
      if (meta.contentHash) {
        if (stateBytes !== sodium.crypto_generichash_STATEBYTES) return null
        if (hasherState.length !== sodium.crypto_generichash_STATEBYTES) return null
      }
      const received = new Set()
      for (let i = 0; i < total; i++) if (bm[i >> 3] & (1 << (i & 7))) received.add(i)
      return { received, hashFrontier, hasherState, hasherBytes }
    } catch { return null }
  }

  // Best-effort async crash-hedge flush: never blocks the receive loop, single-flight
  // (a flush requested while one runs coalesces into one more pass). fsync the partial
  // BEFORE the journal references it so a power-loss can never leave the journal
  // marking a chunk received whose bytes aren't durable.
  _flushJournal (state) {
    if (!state.contentHash || !state.journalPath || state.fd == null) return
    if (state.flushing) { state.flushPending = true; return }
    if (Date.now() - state.lastFlush < JOURNAL_FLUSH_INTERVAL_MS) return
    state.flushing = true
    this._drainFlush(state)
  }

  async _drainFlush (state) {
    do {
      state.flushPending = false
      state.lastFlush = Date.now()
      if (state.fd == null) break
      let buf
      try { buf = this._encodeJournal(state) } catch { break }
      const tmp = state.journalPath + '.tmp'
      try {
        try { await fs.fsync(state.fd) } catch {}
        await fs.writeFile(tmp, buf)
        if (state.fd == null) break // paused/cancelled mid-flush — don't re-create the journal
        await fs.rename(tmp, state.journalPath)
      } catch { try { await fs.unlink(tmp) } catch {} }
    } while (state.flushPending && state.fd != null && state.contentHash)
    try { await fs.unlink(state.journalPath + '.tmp') } catch {}
    state.flushing = false
  }

  // Synchronous durable flush for pause/shutdown, where the app may quit before an
  // async flush would land.
  _flushJournalSync (state) {
    if (!state.contentHash || !state.journalPath) return
    let buf
    try { buf = this._encodeJournal(state) } catch { return }
    if (state.fd != null) { try { fs.fsyncSync(state.fd) } catch {} }
    try {
      const tmp = state.journalPath + '.tmp'
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, state.journalPath)
      state.lastFlush = Date.now()
    } catch { try { fs.unlinkSync(state.journalPath + '.tmp') } catch {} }
  }

  cleanJournals (maxAge) { return cleanupOrphanedJournals(this._journalDir, maxAge) }

  async _hashWholeFileAsync (filePath, size) {
    const h = createStreamingHasher({ size })
    for await (const buf of readFileBlocks(filePath, size, 8 * 1024 * 1024)) {
      h.update(buf)
      await yieldToLoop()
    }
    return h.digest()
  }

  // [mirall] Advance the whole-file hash over the contiguous run of received chunks
  // as a single-flight BACKGROUND pump: chunk index order == file offset order, so
  // once chunk `hashFrontier` is present we feed its bytes and move on. The drain is
  // async + yielding so a large contiguous run that suddenly becomes available (a
  // gap filling after a low-frontier resume) cannot block the worker event loop.
  // Single-flight is `state.draining`, set/cleared SYNCHRONOUSLY inside _drainHash —
  // a stash-fed drain completes without awaiting, so a promise-based gate would stay
  // stale until its microtask clear and block same-macrotask restarts (protomux
  // delivers frame bursts synchronously). advancePromise is only the awaitable
  // handle for finalize/pause; its clear is guarded against nulling a newer drain.
  _advanceHash (state) {
    if (!state.hasher || state.draining) return
    if (!(state.hashFrontier < state.chunks.length && state.received.has(state.hashFrontier))) return
    const p = this._drainHash(state)
    state.advancePromise = p
    p.catch(() => {}).then(() => { if (state.advancePromise === p) state.advancePromise = null })
  }

  async _drainHash (state) {
    state.draining = true
    try {
      let sinceYield = 0
      while (state.fd != null && state.hashFrontier < state.chunks.length && state.received.has(state.hashFrontier)) {
        const i = state.hashFrontier
        const c = state.chunks[i]
        let buf = state.memChunks.get(i)
        if (buf !== undefined) {
          state.memChunks.delete(i)
          state.memBytes -= buf.length
          state.stats.stashHits++
        } else {
          buf = Buffer.alloc(c.length)
          try { await fs.read(state.fd, buf, 0, c.length, c.offset) } catch { return }
          state.stats.readbacks++
        }
        state.hasher.update(buf)
        state.hashFrontier++
        // Yield by BYTE volume: the stash path has no awaits, so a chunk-count
        // cadence would let a gap-fill hash the whole stash synchronously inside
        // the network event that delivered the gap chunk.
        sinceYield += buf.length
        if (sinceYield >= DRAIN_YIELD_BYTES) { sinceYield = 0; await yieldToLoop() }
      }
    } finally {
      state.draining = false
    }
  }

  // [mirall][B1] Close the persistent fd — MUST run before finalize's rename (an
  // open handle blocks the rename on Windows) — and drop the B2 stash.
  _closeFd (state) {
    if (state.fd != null) {
      closeSyncTracked(state.fd)
      state.fd = null
    }
    state.memChunks.clear()
    state.memBytes = 0
  }

  /**
   * Write a received chunk to the partial file. Verifies the hash.
   *
   * @param {string} targetPath - the final file path (used as key)
   * @param {number} index - chunk index
   * @param {Buffer} data - raw chunk bytes
   * @returns {{ ok: boolean, error?: string }}
   */
  writeChunk (targetPath, index, data) {
    const state = this._active.get(targetPath)
    if (!state) return { ok: false, error: 'no active transfer' }
    if (index < 0 || index >= state.chunks.length) return { ok: false, error: 'index out of range' }
    // [mirall][B1] terminal race (chunk landed after close) — codeless so the
    // scheduler re-assigns instead of failing the fetch.
    if (state.fd == null) return { ok: false, error: 'transfer closed' }

    const expected = state.chunks[index]

    // Verify hash
    const actual = hashChunk(data)
    if (actual !== expected.hash) {
      return { ok: false, error: `hash mismatch at index ${index}: expected ${expected.hash.slice(0, 16)}... got ${actual.slice(0, 16)}...` }
    }

    // Verify length
    if (data.length !== expected.length) {
      return { ok: false, error: `length mismatch at index ${index}: expected ${expected.length} got ${data.length}` }
    }

    // Write to partial at the chunk's offset through the persistent fd. A local
    // I/O failure here (ENOSPC / EACCES / EROFS) is fatal and non-retryable —
    // return its code so the scheduler fails the fetch instead of looping over
    // other peers. [mirall] Loop on a SHORT count: libuv swallows an error after
    // partial progress and returns short without throwing; retrying the remainder
    // surfaces the real coded error instead of leaving a silent hole the stash-fed
    // digest would never see.
    try {
      let written = 0
      while (written < data.length) {
        const n = fs.writeSync(state.fd, data, written, data.length - written, expected.offset + written)
        if (!(n > 0)) { const e = new Error(`short write at index ${index}: ${written}/${data.length} bytes`); e.code = 'EIO'; throw e }
        written += n
      }
    } catch (err) {
      return { ok: false, error: err.message, code: err.code }
    }

    state.received.add(index)
    state.bitmap[index >> 3] |= 1 << (index & 7)
    // [mirall][B2] Stash only what the pump can consume cleanly: skip when already
    // hashed or stashed, when the pump is mid-drain on exactly this index, or over
    // cap. Copied, not aliased — wire buffers are views into shared network slabs
    // (udx read slab, decrypted in place by secret-stream), so retaining `data`
    // would pin whole slabs and bet the digest on their write-once behavior.
    if (state.hasher && !state.memChunks.has(index) && state.memBytes + data.length <= this._memStashBytes &&
        (index > state.hashFrontier || (index === state.hashFrontier && !state.draining))) {
      state.memChunks.set(index, Buffer.from(data))
      state.memBytes += data.length
    }
    this._advanceHash(state)
    if (++state.sinceFlush >= JOURNAL_FLUSH_EVERY) { state.sinceFlush = 0; this._flushJournal(state) }

    return { ok: true }
  }

  /**
   * Check if a transfer is complete (all chunks received).
   *
   * @param {string} targetPath
   * @returns {boolean}
   */
  isComplete (targetPath) {
    const state = this._active.get(targetPath)
    if (!state) return false
    return state.received.size === state.total
  }

  /**
   * Finalize a completed transfer — atomic rename from partial to target.
   *
   * @param {string} targetPath
   * @returns {{ ok: boolean, error?: string }}
   */
  async finalize (targetPath) {
    const state = this._active.get(targetPath)
    if (!state) return { ok: false, error: 'no active transfer' }
    if (state.received.size !== state.total) {
      return { ok: false, error: `incomplete: ${state.received.size}/${state.total} chunks` }
    }

    // [mirall] whole-file integrity — computed incrementally by the background hash
    // pump during the transfer. Kick the pump and await it to quiescence, then read
    // the digest (no full re-read). On a mismatch, drop the corrupt partial so a
    // retry starts clean.
    if (state.hasher) {
      this._advanceHash(state)
      while (state.advancePromise) { try { await state.advancePromise } catch {} }
    }
    if (state.contentHash) {
      const actual = state.hashFrontier === state.chunks.length ? state.hasher.digest() : null
      if (actual !== state.contentHash) {
        this._closeFd(state)
        try { fs.unlinkSync(state.partialPath) } catch {}
        if (state.journalPath) { try { fs.unlinkSync(state.journalPath) } catch {} }
        this._active.delete(targetPath)
        return { ok: false, error: 'content-hash mismatch', code: 'EHASHMISMATCH' }
      }
    }
    this._closeFd(state)

    try {
      fs.renameSync(state.partialPath, state.targetPath)
    } catch (err) {
      // [mirall] carry the code (routes through the coded local-I/O rethrow) and
      // clear the state — the partial + journal stay for a clean resume-retry.
      this._active.delete(targetPath)
      return { ok: false, error: 'rename failed: ' + err.message, code: err.code }
    }

    if (state.journalPath) { try { fs.unlinkSync(state.journalPath) } catch {} }
    this._active.delete(targetPath)
    return { ok: true }
  }

  // [mirall] Stop receiving but KEEP the partial on disk so a later startReceive
  // verifies and resumes it. Distinct from cancel(), which unlinks the partial.
  // Drains the in-flight hash advance to the full contiguous frontier first, so the
  // journal captures it and resume stays O(1) (no re-read) and deterministic.
  async pause (targetPath) {
    const state = this._active.get(targetPath)
    if (!state) return
    if (state.hasher) {
      this._advanceHash(state)
      while (state.advancePromise) { try { await state.advancePromise } catch {} }
    }
    this._flushJournalSync(state)
    this._closeFd(state)
    this._active.delete(targetPath)
  }

  /**
   * Cancel an active transfer and clean up the partial file.
   *
   * @param {string} targetPath
   */
  cancel (targetPath) {
    const state = this._active.get(targetPath)
    if (!state) return

    this._closeFd(state)
    try {
      fs.unlinkSync(state.partialPath)
    } catch {
      // partial file may not exist
    }
    if (state.journalPath) { try { fs.unlinkSync(state.journalPath) } catch {} }

    this._active.delete(targetPath)
  }

  /**
   * Get transfer progress for an active transfer.
   *
   * @param {string} targetPath
   * @returns {{ received: number, total: number, percentage: number } | null}
   */
  getProgress (targetPath) {
    const state = this._active.get(targetPath)
    if (!state) return null

    return {
      received: state.received.size,
      total: state.total,
      percentage: state.total > 0 ? Math.round(state.received.size / state.total * 100) : 0
    }
  }

  /**
   * List all active transfers.
   *
   * @returns {Array<{ path: string, received: number, total: number, percentage: number }>}
   */
  listActive () {
    const result = []
    for (const [targetPath, state] of this._active) {
      result.push({
        path: targetPath,
        received: state.received.size,
        total: state.total,
        percentage: state.total > 0 ? Math.round(state.received.size / state.total * 100) : 0
      })
    }
    return result
  }

  /**
   * Clean up stale partial files in a directory (older than maxAge).
   *
   * @param {string} dir - directory to scan
   * @param {number} [maxAge=86400000] - max age in ms (default 24h)
   * @returns {string[]} paths of cleaned files
   */
  cleanPartials (dir, maxAge = 86400000) {
    const cleaned = []
    try {
      const entries = fs.readdirSync(dir)
      const now = Date.now()
      for (const entry of entries) {
        if (!entry.endsWith(this._partialSuffix)) continue
        const full = path.join(dir, entry)
        try {
          const stat = fs.statSync(full)
          if (now - stat.mtimeMs > maxAge) {
            fs.unlinkSync(full)
            cleaned.push(full)
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // directory may not exist
    }
    return cleaned
  }
}
