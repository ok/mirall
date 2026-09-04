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
    err.attempted = attempted
    err.diag = diag
    throw err
  }
}
