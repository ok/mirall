// One overlay fetch, instrumented. Both consumers — the download engine's task and the mirror's
// materialize — build the same ticker, the same diag and the same three callbacks. What differs
// (where the bytes go, what a settle means durably, who owns the row) stays with the caller; only
// the instrumentation lives here.
//
// `attempted` is true once a chunk scheduler ran — i.e. onEnd fired — which is what separates "a
// holder was asked and the transfer died" (a give-up worth a WARN) from "no holder was ever
// reachable" (a benign retry-next-tick). It rides the error too, so a caller that catches can
// still tell the two apart.
import { makeProgressTicker } from '../../progress-ticker.js'
import { makeFetchDiag } from './overlay-backend.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay-fetch')

export async function runOverlayFetch (overlay, contentHash, {
  label, relPath, size = 0, destPath, reSeed = false, onProgress, onVerify, onTick,
}) {
  const ticker = makeProgressTicker(size, onProgress)
  const diag = makeFetchDiag(label, relPath, size, contentHash)
  let attempted = false
  try {
    const res = await overlay.fetchFile(contentHash, {
      destPath,
      reSeed,
      onProgress: (b) => { ticker.pushTo(b); diag.onProgress(b); onTick?.() },
      onVerify,
      onEnd: (info) => { attempted = true; diag.onEnd(info) },
    })
    return { res, attempted, diag }
  } catch (err) {
    // Best-effort: a frozen or primitive rejection makes these assignments throw in strict mode,
    // and that TypeError would REPLACE the real fault — so a full disk would reach the caller as a
    // bug in this file instead of the ENOSPC that must pause the mount. The annotation is a
    // convenience; the fault is not.
    let annotated = false
    try {
      err.attempted = attempted
      err.diag = diag
      annotated = true
    } catch { log.debug('could not annotate a fetch rejection:', label, relPath) }
    // Every caller reaches the diag through `err.diag`, so an annotation that could not land does
    // not just lose the flag — it strands the diag, `diag?.finish('failed')` no-ops, and the
    // `start:` line this fetch already logged never gets its terminal `INCOMPLETE … gave up`. That
    // is precisely the frozen-rejection ENOSPC case above, i.e. the one where the give-up matters
    // most. Nothing downstream can close it, so close it here.
    if (!annotated) diag.finish('failed')
    throw err
  }
}
