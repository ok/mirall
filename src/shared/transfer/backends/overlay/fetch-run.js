// One overlay fetch, instrumented. The mirror's materialize runs the whole thing (runOverlayFetch);
// the download engine builds only the instruments (makeFetchInstruments) and keeps its own settle,
// because its vendor call resolves { ok, code } instead of throwing. What differs (where the bytes
// go, what a settle means durably, who owns the row) stays with the caller.
//
// `attempted` is true once a chunk scheduler ran — i.e. onEnd fired — which is what separates "a
// holder was asked and the transfer died" (a give-up worth a WARN) from "no holder was ever
// reachable" (a benign retry-next-tick). It rides the error too, so a caller that catches can
// still tell the two apart.
import { makeProgressTicker } from '../../progress-ticker.js'
import { makeFetchDiag } from './overlay-backend.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay-fetch')

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
