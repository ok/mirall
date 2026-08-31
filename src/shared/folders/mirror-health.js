// The wedged/healthy rule for a mirror loop, kept pure so it is asserted directly rather than
// through a live loop.
//
// Progress, not elapsed time: runMaterializeTick serialises passes per mount by handing every
// later tick the in-flight promise, so a pass that never settles wedges the mount permanently while
// the interval keeps firing. But an initial scan over thousands of files is legitimately slow, and
// an elapsed-time rule would restart it mid-scan. Only a pass that is in flight AND not advancing
// is wedged.
export const STALL_FACTOR = 20

export function mirrorVerdict(liveness, { now, pollIntervalMs, stallFactor = STALL_FACTOR }) {
  const { startedAt = 0, progressAt = 0 } = liveness || {}
  if (!startedAt) return { ok: true, detail: null }
  const stalledForMs = now - (progressAt || startedAt)
  if (stalledForMs <= pollIntervalMs * stallFactor) return { ok: true, detail: null }
  return { ok: false, detail: `no progress for ${Math.round(stalledForMs / 1000)}s` }
}
