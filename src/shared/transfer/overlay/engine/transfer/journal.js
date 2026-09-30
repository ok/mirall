// The resume journal: a receive's chunk bitmap and whole-file hash snapshot, stored in app-private
// storage keyed by a digest of the destination path — never next to the download — so a resume is
// O(1) and the incremental verify continues without a re-read. This module owns its name, byte
// format, load, crash-hedge flush and the orphan sweep.

import fs from 'bare-fs'
import path from 'bare-path'
import c from 'compact-encoding'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { hashChunk } from '../chunker.js'

const JOURNAL_SUFFIX = '.journal'
export const JOURNAL_MAGIC = 0x4d4a5633
export const JOURNAL_FLUSH_EVERY = 512
const JOURNAL_FLUSH_INTERVAL_MS = 1500

export const journalNameFor = (targetPath) => hashChunk(Buffer.from(targetPath)) + JOURNAL_SUFFIX

export const journalPathFor = (journalDir, targetPath) => path.join(journalDir, journalNameFor(targetPath))

export function hasJournal(journalDir, targetPath) {
  try { return fs.existsSync(journalPathFor(journalDir, targetPath)) } catch { return false }
}

// Best-effort: a missing journal is already the goal.
export function discardJournal(journalDir, targetPath) {
  try { fs.unlinkSync(journalPathFor(journalDir, targetPath)) } catch {}
}

export function bitmapOf(received, total) {
  const bm = Buffer.alloc((total + 7) >> 3)
  for (const i of received) bm[i >> 3] |= 1 << (i & 7)
  return bm
}

const readBuffer = (file) => /** @type {Buffer} */ (fs.readFileSync(file))

// Drop journals whose partial is gone, that are stale, or that are corrupt or foreign. Each journal
// names its partial in its header, which is all this reads, so a journal with a corrupt tail and a
// live partial is kept. Standalone, so a boot sweep can reclaim orphans without the engine running.
export function cleanupOrphanedJournals(journalDir, maxAge = 7 * 86400000) {
  const cleaned = []
  if (!journalDir) return cleaned
  let entries
  try { entries = fs.readdirSync(journalDir) } catch { return cleaned }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.endsWith(JOURNAL_SUFFIX)) continue
    const full = path.join(journalDir, entry)
    if (!orphaned(full, now, maxAge)) continue
    try { fs.unlinkSync(full); cleaned.push(full) } catch {}
  }
  return cleaned
}

function orphaned(full, now, maxAge) {
  try {
    const raw = readBuffer(full)
    const s = { start: 0, end: raw.length, buffer: raw }
    if (c.uint32.decode(s) !== JOURNAL_MAGIC) return true
    c.uint32.decode(s)
    const partialPath = c.string.decode(s)
    if (!fs.existsSync(partialPath)) return true
    return now - fs.statSync(full).mtimeMs > maxAge
  } catch {
    return true
  }
}

export function encodeJournal(state) {
  const ch = state.contentHash ? Buffer.from(state.contentHash, 'hex') : Buffer.alloc(32)
  const snap = state.hasher ? state.hasher.snapshot() : { state: Buffer.alloc(0), bytes: 0 }
  const fields = [
    [c.uint32, JOURNAL_MAGIC],
    [c.uint32, sodium.crypto_generichash_STATEBYTES],
    [c.string, state.partialPath],
    [c.uint64, state.size],
    [c.uint32, state.total],
    [c.fixed32, ch],
    [c.uint32, state.hashFrontier],
    [c.uint64, snap.bytes],
    [c.buffer, snap.state],
    [c.buffer, state.bitmap],
  ]
  const s = { start: 0, end: 0, buffer: null }
  for (const [enc, value] of fields) enc.preencode(s, value)
  s.buffer = Buffer.allocUnsafe(s.end)
  for (const [enc, value] of fields) enc.encode(s, value)
  return s.buffer
}

// The resume state, only when the journal is for this partial, binds to this content and its
// snapshot is restorable on this libsodium build; else null, and the caller re-verifies instead.
export function loadJournal(journalPath, partialPath, meta) {
  let raw
  try { raw = readBuffer(journalPath) } catch { return null }
  try {
    const s = { start: 0, end: raw.length, buffer: raw }
    if (c.uint32.decode(s) !== JOURNAL_MAGIC) return null
    const stateBytes = c.uint32.decode(s)
    const storedPartial = c.string.decode(s)
    const size = c.uint64.decode(s)
    const total = c.uint32.decode(s)
    const ch = b4a.toString(c.fixed32.decode(s), 'hex')
    const hashFrontier = c.uint32.decode(s)
    const hasherBytes = c.uint64.decode(s)
    const hasherState = c.buffer.decode(s)
    const bm = c.buffer.decode(s)
    if (storedPartial !== partialPath) return null
    if (size !== meta.size || total !== meta.chunks.length) return null
    if (meta.contentHash && ch !== meta.contentHash) return null
    if (meta.contentHash && (stateBytes !== sodium.crypto_generichash_STATEBYTES || hasherState.length !== stateBytes)) return null
    const received = new Set()
    for (let i = 0; i < total; i++) if (bm[i >> 3] & (1 << (i & 7))) received.add(i)
    return { received, hashFrontier, hasherState, hasherBytes }
  } catch {
    return null
  }
}

// A best-effort async crash-hedge flush: it never blocks the receive loop and is single-flight (a
// flush requested while one runs coalesces into one more pass). The partial is fsynced BEFORE the
// journal references it, so a power loss never leaves a chunk marked received whose bytes are not
// durable.
export function flushJournal(state) {
  if (!state.contentHash || !state.journalPath || state.fd == null) return
  if (state.flushing) { state.flushPending = true; return }
  if (Date.now() - state.lastFlush < JOURNAL_FLUSH_INTERVAL_MS) return
  state.flushing = true
  drainFlush(state)
}

async function drainFlush(state) {
  do {
    state.flushPending = false
    state.lastFlush = Date.now()
    if (state.fd == null) break
    let buf
    try { buf = encodeJournal(state) } catch { break }
    const tmp = state.journalPath + '.tmp'
    try {
      try { await fs.fsync(state.fd) } catch {}
      await fs.writeFile(tmp, buf)
      // Paused or cancelled mid-flush: the journal is not re-created.
      if (state.fd == null) break
      await fs.rename(tmp, state.journalPath)
    } catch { try { await fs.unlink(tmp) } catch {} }
  } while (state.flushPending && state.fd != null && state.contentHash)
  try { await fs.unlink(state.journalPath + '.tmp') } catch {}
  state.flushing = false
}

// A synchronous durable flush for pause and shutdown, where the app may quit before an async
// flush would land.
export function flushJournalSync(state) {
  if (!state.contentHash || !state.journalPath) return
  let buf
  try { buf = encodeJournal(state) } catch { return }
  if (state.fd != null) { try { fs.fsyncSync(state.fd) } catch {} }
  try {
    const tmp = state.journalPath + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, state.journalPath)
    state.lastFlush = Date.now()
  } catch { try { fs.unlinkSync(state.journalPath + '.tmp') } catch {} }
}
