// One overlay fetch: the gate bracket both producers hold a slot through (runGatedFetch), and the
// one vendor call both make while holding it (callVendor). What differs (where the bytes go, what a
// settle means durably, who owns the row, which outcome closes the diag) stays with the caller.
//
// `attempted` is true once a chunk scheduler ran — i.e. onEnd fired — which is what separates "a
// holder was asked and the transfer died" (a give-up worth a WARN) from "no holder was ever
// reachable" (a benign retry-next-tick).
//
// Imports nothing that only loads under Bare, so test/unit drives the diag and the bracket directly.
import { makeProgressTicker } from '../progress-ticker.js'
import { createLogger } from '../../core/logger.js'
import { DELIBERATE_STOPS, FETCH_OUTCOME } from './fetch-outcome.js'
import { acquireFetchSlot } from './fetch-gate.js'

const log = createLogger('overlay-fetch')

// Download instrumentation: logs fetch start, throttled mid-download progress (every 5s), the
// scheduler's terminal reason (timeout vs complete, with bytes/chunks transferred), and the final
// outcome — so a stalled large-file transfer reveals exactly where and why it stopped.
//
// finish(outcome): a member of FETCH_OUTCOME. 'done' on success; a deliberate stop (a pause, a
// cancel, a supersede, no holder, a republish park) is normal control flow and logs at debug — NOT
// a WARN "gave up", which would make a user pausing a download read as a failure. Only a genuine
// give-up ('failed' — timeout / stall / no live holder / hash mismatch) warrants the WARN. An
// outcome outside the vocabulary (caller bug) is fail-safe: it WARNs rather than silently logging
// at debug.
export function makeFetchDiag(label, relPath, total, contentHash) {
  const t0 = Date.now()
  let lastLog = 0
  let lastBytes = 0
  log.info(`${label} start:`, relPath, `size=${total}`, `hash=${(contentHash || '').slice(0, 12)}`)
  return {
    onProgress(bytes) {
      lastBytes = bytes
      const now = Date.now()
      if (now - lastLog < 5000) return
      lastLog = now
      const elapsed = (now - t0) / 1000
      const pct = total ? Math.floor((bytes / total) * 100) : 0
      const rate = elapsed > 0 ? (bytes / elapsed / 1048576).toFixed(1) : '0'
      log.info(`${label} progress:`, relPath, `${bytes}/${total} (${pct}%)`, `${rate} MB/s`, `elapsed=${elapsed.toFixed(0)}s`)
    },
    onEnd(info) {
      log.info(`${label} scheduler end:`, relPath, info.reason,
        `${info.receivedBytes}/${info.totalBytes} bytes`,
        `chunks ${info.totalChunks - info.chunksRemaining}/${info.totalChunks}`,
        `peers=${info.peers}`, `elapsed=${(info.elapsedMs / 1000).toFixed(0)}s`)
    },
    finish(outcome) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
      if (outcome === FETCH_OUTCOME.DONE) {
        log.info(`${label} done:`, relPath, `${total} bytes in ${elapsed}s`)
      } else if (DELIBERATE_STOPS.has(outcome)) {
        log.debug(`${label} ${outcome}:`, relPath, `at ${lastBytes}/${total} bytes after ${elapsed}s`)
      } else {
        const tag = outcome !== FETCH_OUTCOME.FAILED ? ` [outcome='${outcome}']` : ''
        log.warn(`${label} INCOMPLETE:`, relPath, `gave up after ${elapsed}s at ${lastBytes}/${total} bytes${tag}`)
      }
    },
  }
}

// The ticker, the diag, and the three callbacks that wire them together: everything built around
// the vendor call.
function makeFetchInstruments({ label, relPath, size = 0, contentHash = null, onProgress, onVerify, onTick }) {
  const ticker = makeProgressTicker(size, onProgress)
  const diag = makeFetchDiag(label, relPath, size, contentHash)
  return {
    diag,
    callbacks: {
      onProgress: (b) => { ticker.pushTo(b); diag.onProgress(b); onTick?.() },
      onVerify,
      onEnd: diag.onEnd,
    },
  }
}

// The gated half every producer runs: a slot on its lane, then a re-check of whatever the wait may
// have changed (it is unbounded, and a drained gate resumes waiters with a no-op release), then the
// producer's own fetch and settle while the slot is held. The bracket owns the slot, so it releases
// it on every exit, a `wait` that throws included, and a throw from any hook reaches the caller
// unchanged. Everything else (the claim, the in-flight marker, the abort and the fault policy) stays
// with each producer, inside `holding`.
/**
 * @template T
 * @param {{
 *   express?: boolean,
 *   owner?: string | null,
 *   wait?: (acquire: () => Promise<() => void>) => Promise<() => void>,
 *   recheck: () => string | null,
 *   abandon: (reason: string) => T | Promise<T>,
 *   holding: () => Promise<T>,
 * }} task
 * @returns {Promise<T>}
 */
export async function runGatedFetch({ express = false, owner = null, wait = (acquire) => acquire(), recheck, abandon, holding }) {
  /** @type {Promise<() => void> | null} */
  let slot = null
  let release
  try {
    release = await wait(() => (slot = acquireFetchSlot({ express, owner })))
  } catch (err) {
    // Whenever the gate admits it: a wait can throw while the slot is still queued.
    slot?.then((free) => free(), () => {})
    throw err
  }
  try {
    const reason = recheck()
    if (reason) return await abandon(reason)
    return await holding()
  } finally {
    release()
  }
}

// The vendor call both producers make inside their `holding`. It never throws: a rejection comes
// back as `err`, the very value the vendor rejected with, so a frozen or primitive fault reaches the
// caller's fault policy unchanged. The diag comes back open on every path, because which outcome
// closes it is the caller's verdict. Every option but the instruments' own is the vendor's, passed
// through as given.
/**
 * @param {{ fetchFile: (contentHash: string, opts: object) => Promise<unknown> }} vendor
 * @param {string} contentHash
 * @param {{
 *   label?: string,
 *   relPath: string,
 *   size?: number,
 *   onProgress?: (progress: { bytes: number, total: number, speed: number, eta: number | null }) => void,
 *   onVerify?: (fraction: number, recovered?: number) => void,
 *   onTick?: () => void,
 *   [vendorOption: string]: unknown,
 * }} opts
 */
export async function callVendor(vendor, contentHash, { label, relPath, onProgress, onVerify, onTick, ...request }) {
  let attempted = false
  const { diag, callbacks } = makeFetchInstruments({ label, relPath, size: request.size, contentHash, onProgress, onVerify, onTick })
  try {
    const res = await vendor.fetchFile(contentHash, {
      ...request,
      ...callbacks,
      onEnd: (info) => { attempted = true; callbacks.onEnd(info) },
    })
    return { res, err: null, attempted, diag }
  } catch (err) {
    return { res: null, err, attempted, diag }
  }
}
