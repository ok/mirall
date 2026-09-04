// Should this leftover sweep be allowed to delete anything?
//
// The sweep's deletes are irreversible RocksDB range deletes with no backup and no undo, decided
// against a "wanted" set that is assembled best-effort from a dozen reads. Both guards here
// therefore fail CLOSED: the cost of skipping a sweep is one boot's worth of unreclaimed
// housekeeping bytes, and the cost of an unsafe sweep is the user's spaces.
//
// Pure — no store, no clock, no IO — so every branch is unit-testable, in the same shape as
// supersede-decision.js / stall-verdict.js / mount-fault.js.

export const SWEEP_REFUSAL = {
  // The wanted set could not be built completely, so "not wanted" does not mean "not needed".
  SCAN_INCOMPLETE: 'scan-incomplete',
  OVER_ABSOLUTE_CAP: 'over-absolute-cap',
  OVER_RATIO_CAP: 'over-ratio-cap',
}

export function decideSweep ({ gaps = [], targetCount = 0, totalCores = 0, caps = {} } = {}) {
  const minCores = caps.minSweepPurgeCores ?? 8
  const maxCores = caps.maxSweepPurgeCores ?? 64
  const ratio = caps.maxSweepPurgeRatio ?? 0.5

  // Nothing to delete outranks every other consideration: there is no risk to weigh, and refusing
  // here would write a refusal row on every clean boot and bury the real ones.
  if (targetCount === 0) return { allow: true, reason: null, limit: 0, gaps: [] }

  // One rule, deliberately not per-category. Mapping each gap to the classifications it can reach
  // ("an overlay gap only endangers file-index cores") is an inference that is true today and goes
  // stale silently the next time a classification changes — the same shape as the defect this
  // guard exists to fix.
  if (gaps.length > 0) return { allow: false, reason: SWEEP_REFUSAL.SCAN_INCOMPLETE, limit: 0, gaps }

  if (targetCount > maxCores) return { allow: false, reason: SWEEP_REFUSAL.OVER_ABSOLUTE_CAP, limit: maxCores, gaps }

  // The floor is applied first so a fresh install is not held hostage by the ratio: a bare 50%
  // rule would refuse an ordinary 3-core sweep of a 6-core store.
  const ratioLimit = Math.max(minCores, Math.floor(totalCores * ratio))
  if (targetCount > ratioLimit) return { allow: false, reason: SWEEP_REFUSAL.OVER_RATIO_CAP, limit: ratioLimit, gaps }

  return { allow: true, reason: null, limit: Math.min(maxCores, ratioLimit), gaps: [] }
}
