// One overlay fetch, instrumented. The mirror's materialize runs the whole thing (runOverlayFetch);
// the download engine builds only the instruments (makeFetchInstruments) and keeps its own settle,
// because its vendor call resolves { ok, code } instead of throwing. What differs (where the bytes
// go, what a settle means durably, who owns the row) stays with the caller.
//
// `attempted` is true once a chunk scheduler ran — i.e. onEnd fired — which is what separates "a
// holder was asked and the transfer died" (a give-up worth a WARN) from "no holder was ever
// reachable" (a benign retry-next-tick). It rides the error too, so a caller that catches can
// still tell the two apart.
//
// Imports nothing that only loads under Bare, so test/unit drives the diag directly.
import { makeProgressTicker } from '../../progress-ticker.js'
import { createLogger } from '../../../core/logger.js'
import { DELIBERATE_STOPS, FETCH_OUTCOME } from './fetch-outcome.js'

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

// The ticker, the diag, and the three callbacks that wire them together — everything either
// consumer builds AROUND the vendor call.
export function makeFetchInstruments({ label, relPath, size = 0, contentHash = null, onProgress, onVerify, onTick }) {
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

export async function runOverlayFetch(overlay, contentHash, {
  label, relPath, size = 0, destPath, reSeed = false, onProgress, onVerify, onTick,
}) {
  let attempted = false
  const { diag, callbacks } = makeFetchInstruments({ label, relPath, size, contentHash, onProgress, onVerify, onTick })
  try {
    const res = await overlay.fetchFile(contentHash, {
      destPath,
      reSeed,
      ...callbacks,
      onEnd: (info) => { attempted = true; callbacks.onEnd(info) },
    })
    return { res, attempted, diag }
  } catch (err) {
    // Best-effort: a frozen or primitive rejection makes these assignments throw, and that
    // TypeError would REPLACE the real fault (an ENOSPC that must pause the mount). The annotation
    // is a convenience; the fault is not.
    let annotated = false
    try {
      err.attempted = attempted
      err.diag = diag
      annotated = true
    } catch { log.debug('could not annotate a fetch rejection:', label, relPath) }
    // Callers reach the diag only through `err.diag`, so an annotation that could not land would
    // strand it and the `start:` line would never get its terminal `INCOMPLETE`. Close it here.
    if (!annotated) diag.finish('failed')
    throw err
  }
}
