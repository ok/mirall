// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/transfer.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// TransferManager — every receive in flight and its verbs: write each hash-verified chunk into a
// visible partial at its offset, keep the whole-file hash and the resume journal current, and
// rename atomically on completion. It also exposes the serve reads and prepare, so the protocol and
// the scheduler see one collaborator. No blob storage: chunk bytes exist in memory only in transit.

import fs from 'bare-fs'
import path from 'bare-path'
import { hashChunk, createStreamingHasher } from '../chunker.js'
import { codedError } from '../local-faults.js'
import { openSyncTracked, closeSyncTracked } from './fd-accounting.js'
import { openChunkSource, readChunkAt, closeChunkSource } from './serve-reads.js'
import { prepareForServe } from './prepare.js'
import { advanceHash, settleHash, recoverPartial } from './receive-hash.js'
import { JOURNAL_FLUSH_EVERY, journalPathFor, bitmapOf, loadJournal, flushJournal, flushJournalSync, cleanupOrphanedJournals } from './journal.js'

// The standalone default for an embedder that injects nothing. The host injects its own suffix
// through `partialSuffix`; app code never reads this one, since it knows nothing of the injection.
export const PARTIAL_SUFFIX = '.overlay-partial'

// A bounded stash of just-received verified chunks per transfer, so the hash pump feeds from
// memory instead of reading the bytes back off disk.
const MEM_STASH_BYTES_DEFAULT = 16 * 1024 * 1024

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

// What sits at a receive's target, compared across the receive.
function targetFingerprint(targetPath) {
  try {
    const st = fs.lstatSync(targetPath)
    return st.ino + ':' + st.size + ':' + st.mtimeMs
  } catch {
    return null
  }
}

function unlinkQuietly(file) {
  if (!file) return
  try { fs.unlinkSync(file) } catch {}
}

export class TransferManager {
  constructor(fileIndex, opts = {}) {
    this._fileIndex = fileIndex
    this._active = new Map() // final path → receive state
    this._memStashBytes = opts.memStashBytes ?? MEM_STASH_BYTES_DEFAULT
    this._journalDir = opts.journalDir || null
    this._partialSuffix = opts.partialSuffix || PARTIAL_SUFFIX
    if (this._journalDir) { try { fs.mkdirSync(this._journalDir, { recursive: true }) } catch {} }
  }

  prepareFile(filePath, opts) { return prepareForServe(this._fileIndex, filePath, opts) }
  openChunkSource(filePath) { return openChunkSource(filePath) }
  readChunkAt(fd, offset, length) { return readChunkAt(fd, offset, length) }
  closeChunkSource(fd) { return closeChunkSource(fd) }
  cleanJournals(maxAge) { return cleanupOrphanedJournals(this._journalDir, maxAge) }

  /** @internal */
  receiveState(targetPath) { return this._active.get(targetPath) ?? null }

  // Start receiving a file. A same-size partial is resumed: the journal restores the received set
  // and hash snapshot in O(1); failing that, an async, yielding re-verify rebuilds them.
  // opts.isCancelled aborts a long re-verify, opts.onVerifyProgress(0..1) reports it, and
  // opts.parentMustExist refuses to recreate a folder the caller made and the user deleted since.
  async startReceive(targetPath, meta, opts = {}) {
    const isCancelled = opts.isCancelled || (() => false)
    const dir = path.dirname(targetPath)
    // Visible (no leading dot), so an in-progress download shows in the folder.
    const partialPath = path.join(dir, path.basename(targetPath) + this._partialSuffix)
    const journalPath = this._journalDir ? journalPathFor(this._journalDir, targetPath) : null
    if (opts.parentMustExist) {
      if (!isDirectory(dir)) throw codedError('receive folder is gone: ' + dir, 'ENOENT')
    } else {
      fs.mkdirSync(dir, { recursive: true })
    }
    const resumed = isResumablePartial(partialPath, meta.size)
    const resume = resumed ? await this._resumeState(journalPath, partialPath, meta, isCancelled, opts.onVerifyProgress) : freshState(meta)
    if (!resumed) unlinkQuietly(journalPath)
    if (isCancelled()) throw codedError('receive cancelled during setup', 'ECANCELLED')
    const fd = openPartial(partialPath, resumed, meta.size)
    const state = {
      partialPath,
      targetPath,
      targetFingerprint: targetFingerprint(targetPath),
      journalPath,
      chunks: meta.chunks,
      received: resume.received,
      bitmap: bitmapOf(resume.received, meta.chunks.length),
      total: meta.chunks.length,
      size: meta.size,
      contentHash: meta.contentHash || null,
      hasher: resume.hasher,
      hashFrontier: resume.hashFrontier,
      advancePromise: null,
      draining: false,
      sinceFlush: 0,
      lastFlush: 0,
      flushing: false,
      flushPending: false,
      fd,
      // Never load-bearing: bytes hit disk first, and a miss falls back to read-back.
      memChunks: new Map(),
      memBytes: 0,
      stats: { readbacks: 0, stashHits: 0 },
    }
    // A prior receive of this path that ended in a failure leaves its state here with an open fd;
    // it is closed before being replaced, so a retry cannot orphan it.
    const prev = this._active.get(targetPath)
    if (prev) this._closeFd(prev)
    this._active.set(targetPath, state)
    // A resume that recovered chunks persists them now, so an immediate re-pause is O(1).
    if (resume.received.size > 0) flushJournal(state)
    return state
  }

  // Write a received chunk into the partial at its offset, after verifying its hash and length. A
  // local I/O failure returns its code, which the scheduler treats as fatal unless transient. A
  // short write is retried for the remainder: libuv swallows an error after partial progress and
  // returns short, and the retry surfaces the real coded error instead of a silent hole.
  writeChunk(targetPath, index, data) {
    const state = this._active.get(targetPath)
    if (!state) return { ok: false, error: 'no active transfer' }
    if (index < 0 || index >= state.chunks.length) return { ok: false, error: 'index out of range' }
    // A chunk that landed after close: codeless, so the scheduler re-assigns instead of failing.
    if (state.fd == null) return { ok: false, error: 'transfer closed' }
    const expected = state.chunks[index]
    const actual = hashChunk(data)
    if (actual !== expected.hash) {
      return { ok: false, error: `hash mismatch at index ${index}: expected ${expected.hash.slice(0, 16)}... got ${actual.slice(0, 16)}...` }
    }
    if (data.length !== expected.length) {
      return { ok: false, error: `length mismatch at index ${index}: expected ${expected.length} got ${data.length}` }
    }
    try {
      let written = 0
      while (written < data.length) {
        const n = fs.writeSync(state.fd, data, written, data.length - written, expected.offset + written)
        if (!(n > 0)) throw codedError(`short write at index ${index}: ${written}/${data.length} bytes`, 'EIO')
        written += n
      }
    } catch (err) {
      return { ok: false, error: err.message, code: err.code }
    }
    state.received.add(index)
    state.bitmap[index >> 3] |= 1 << (index & 7)
    this._stash(state, index, data)
    advanceHash(state)
    if (++state.sinceFlush >= JOURNAL_FLUSH_EVERY) { state.sinceFlush = 0; flushJournal(state) }
    return { ok: true }
  }

  // Atomic rename from partial to target once every chunk is in and the incremental whole-file hash
  // matches. On a mismatch the corrupt partial goes, so a retry starts clean. The target must still
  // be what it was when the receive began: a file that appeared or was replaced meanwhile is not
  // ours to overwrite, so the partial and journal go with the name.
  async finalize(targetPath) {
    const state = this._active.get(targetPath)
    if (!state) return { ok: false, error: 'no active transfer' }
    if (state.received.size !== state.total) {
      return { ok: false, error: `incomplete: ${state.received.size}/${state.total} chunks` }
    }
    await settleHash(state)
    if (state.contentHash) {
      const actual = state.hashFrontier === state.chunks.length ? state.hasher.digest() : null
      if (actual !== state.contentHash) {
        this._closeFd(state)
        this._discard(targetPath, state)
        return { ok: false, error: 'content-hash mismatch', code: 'EHASHMISMATCH' }
      }
    }
    this._closeFd(state)
    if (targetFingerprint(state.targetPath) !== state.targetFingerprint) {
      this._discard(targetPath, state)
      return { ok: false, error: 'target changed during receive', code: 'ETARGETCHANGED' }
    }
    try {
      fs.renameSync(state.partialPath, state.targetPath)
    } catch (err) {
      // The code routes through the local-fault rethrow; the partial and journal stay for a resume.
      this._active.delete(targetPath)
      return { ok: false, error: 'rename failed: ' + err.message, code: err.code }
    }
    unlinkQuietly(state.journalPath)
    this._active.delete(targetPath)
    return { ok: true }
  }

  // Stop receiving but KEEP the partial, so a later startReceive resumes it. The hash is drained to
  // the full contiguous frontier first, so the journal captures it and the resume stays O(1).
  async pause(targetPath) {
    const state = this._active.get(targetPath)
    if (!state) return
    await settleHash(state)
    flushJournalSync(state)
    this._closeFd(state)
    this._active.delete(targetPath)
  }

  cancel(targetPath) {
    const state = this._active.get(targetPath)
    if (!state) return
    this._closeFd(state)
    this._discard(targetPath, state)
  }

  _resumeState(journalPath, partialPath, meta, isCancelled, onVerifyProgress) {
    const j = journalPath ? loadJournal(journalPath, partialPath, meta) : null
    if (!j) return recoverPartial(partialPath, meta, isCancelled, onVerifyProgress)
    const hasher = meta.contentHash ? createStreamingHasher({ size: meta.size, restore: { state: j.hasherState, bytes: j.hasherBytes } }) : null
    return { received: j.received, hasher, hashFrontier: j.hashFrontier }
  }

  // Stash only what the pump can consume cleanly: not when already hashed or stashed, not when the
  // pump is mid-drain on exactly this index, and not over the cap. Copied, not aliased: wire
  // buffers are views into shared network slabs, and retaining one would pin the whole slab.
  _stash(state, index, data) {
    if (!state.hasher || state.memChunks.has(index) || state.memBytes + data.length > this._memStashBytes) return
    if (!(index > state.hashFrontier || (index === state.hashFrontier && !state.draining))) return
    state.memChunks.set(index, Buffer.from(data))
    state.memBytes += data.length
  }

  _discard(targetPath, state) {
    unlinkQuietly(state.partialPath)
    unlinkQuietly(state.journalPath)
    this._active.delete(targetPath)
  }

  // Runs before finalize's rename: an open handle blocks the rename on Windows.
  _closeFd(state) {
    if (state.fd != null) {
      closeSyncTracked(state.fd)
      state.fd = null
    }
    state.memChunks.clear()
    state.memBytes = 0
  }
}

// Only a regular file of the right size is a partial to resume: lstat, because a link at the
// partial's name would carry the writes to wherever it points.
function isResumablePartial(partialPath, size) {
  try {
    const st = fs.lstatSync(partialPath)
    return st.isFile() && st.size === size
  } catch {
    return false
  }
}

function freshState(meta) {
  return { received: new Set(), hasher: meta.contentHash ? createStreamingHasher({ size: meta.size }) : null, hashFrontier: 0 }
}

// One fd serves the whole receive: positioned writes and reads never move a shared cursor, so it
// carries the chunk writes, the pump's read-back and the journal fsync. A fresh partial replaces
// whatever holds the name (unlinking a link removes the link, not its target) and is created
// exclusively, so a name that reappears in between is refused.
function openPartial(partialPath, resumed, size) {
  if (resumed) return openSyncTracked(partialPath, 'r+')
  unlinkQuietly(partialPath)
  const fd = openSyncTracked(partialPath, 'wx+')
  try { fs.ftruncateSync(fd, size) } catch (err) { closeSyncTracked(fd); throw err }
  return fd
}
