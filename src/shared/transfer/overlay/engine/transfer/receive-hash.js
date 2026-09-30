// The whole-file hash of a receive, advanced over the contiguous received prefix without blocking
// the worker loop, and the rebuild of a same-size partial's received set when there is no journal.

import { hashChunk, createStreamingHasher } from '../chunker.js'
import { codedError } from '../local-faults.js'
import { openTracked, closeTracked, readFully } from './fd-accounting.js'
import { yieldToLoop } from '../yield-to-loop.js'

const VERIFY_YIELD_EVERY = 64
// The stash-fed drain never awaits, so the pump yields by bytes hashed, not by chunk count.
const DRAIN_YIELD_BYTES = 2 * 1024 * 1024

// Chunk index order is file offset order, so once chunk `hashFrontier` is present its bytes are
// fed and the frontier moves. A single-flight background pump: `state.draining` is set and cleared
// synchronously inside drainHash, because a stash-fed drain completes without awaiting and a
// promise-based gate would stay stale until its microtask clear (protomux delivers frame bursts
// synchronously). `advancePromise` is only the awaitable handle for finalize and pause; its clear
// is guarded against nulling a newer drain.
export function advanceHash(state) {
  if (!state.hasher || state.draining) return
  if (!(state.hashFrontier < state.chunks.length && state.received.has(state.hashFrontier))) return
  const p = drainHash(state)
  state.advancePromise = p
  p.catch(() => {}).then(() => { if (state.advancePromise === p) state.advancePromise = null })
}

// Run the pump to quiescence.
export async function settleHash(state) {
  if (!state.hasher) return
  advanceHash(state)
  while (state.advancePromise) { try { await state.advancePromise } catch {} }
}

async function drainHash(state) {
  state.draining = true
  try {
    let sinceYield = 0
    while (state.fd != null && state.hashFrontier < state.chunks.length && state.received.has(state.hashFrontier)) {
      // A stash hit is taken synchronously: only a read-back awaits.
      const buf = takeStashed(state, state.hashFrontier) ?? await readBack(state, state.hashFrontier)
      if (!buf) return
      state.hasher.update(buf)
      state.hashFrontier++
      sinceYield += buf.length
      if (sinceYield >= DRAIN_YIELD_BYTES) { sinceYield = 0; await yieldToLoop() }
    }
  } finally {
    state.draining = false
  }
}

function takeStashed(state, i) {
  const stashed = state.memChunks.get(i)
  if (stashed === undefined) return null
  state.memChunks.delete(i)
  state.memBytes -= stashed.length
  state.stats.stashHits++
  return stashed
}

// Null on an error or a short read: a zero-filled tail must never reach the hasher.
async function readBack(state, i) {
  const c = state.chunks[i]
  const buf = Buffer.alloc(c.length)
  let n = 0
  try { n = await readFully(state.fd, buf, c.length, c.offset) } catch { return null }
  if (n !== c.length) return null
  state.stats.readbacks++
  return buf
}

// Rebuild the received set from a same-size partial: async reads, a yield every
// VERIFY_YIELD_EVERY chunks, and the contiguous prefix fed into the hasher inline (one pass).
export async function recoverPartial(partialPath, meta, isCancelled, onVerifyProgress) {
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
      if (isCancelled()) throw codedError('receive recovery cancelled', 'ECANCELLED')
      const ci = meta.chunks[i]
      let n = 0
      try { n = await readFully(fd, buf, ci.length, ci.offset) } catch {}
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
