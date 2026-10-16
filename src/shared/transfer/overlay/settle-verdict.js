// The precedence a finished fetch is judged by, and the reasons a reserved slot stops short of
// one. Pure: both read the live slot and perform nothing, so the order of the rungs is asserted in
// test/unit rather than through a live engine. No bare-* imports.

export const SETTLE = Object.freeze({
  PARK: 'park',
  RESTART: 'restart',
  CANCELLED: 'cancelled',
  DISCARDED: 'discarded',
  PAUSED: 'paused',
  STALLED: 'stalled',
  FAILED: 'failed',
  DONE: 'done',
})

// A supersede and an explicit user pause/cancel carry a stronger intent than the republish park,
// so they rank above it; the park ranks above the result, because a fetch doomed by a re-hash has
// nothing to say however it settled. Only below that does the result speak: ECANCELLED is a pause
// when the slot says so and an already-handled discard otherwise; a code-less miss is a stall.
export function settleVerdict(slot, result) {
  const paused = !!slot?.paused
  const cancelled = !!slot?.cancelled
  const restartJob = slot?.restartJob ?? null
  if (slot?.republishing && !restartJob && !cancelled && !paused) return SETTLE.PARK
  if (restartJob) return SETTLE.RESTART
  if (cancelled) return SETTLE.CANCELLED
  if (result.code === 'ECANCELLED') return paused ? SETTLE.PAUSED : SETTLE.DISCARDED
  if (result.ok) return SETTLE.DONE
  return result.code ? SETTLE.FAILED : SETTLE.STALLED
}

export const ABANDON = Object.freeze({
  RESTART: 'restart',
  CANCELLED: 'cancelled',
  PAUSED: 'paused',
  NO_OVERLAY: 'no-overlay',
  OFFLINE: 'offline',
  // The registry no longer holds this slot: a pause, a cancel or a republish released it while it
  // was parked, and whatever holds the id now is another attempt's. Nothing to settle.
  STALE: 'stale',
})

// Why a reserved slot must not fetch, asked after every await between the reservation and the
// engine call. `hasOverlay` is optional: the pre-fetch guard in start() never asked it, the
// post-gate guard does (see drainFetchSlots in fetch-gate.js).
export function abandonReason(slot, { ownerOnline, hasOverlay = null, live = null }) {
  if (live && !live()) return ABANDON.STALE
  if (slot.cancelled) return slot.restartJob ? ABANDON.RESTART : ABANDON.CANCELLED
  if (slot.paused) return ABANDON.PAUSED
  if (hasOverlay && !hasOverlay()) return ABANDON.NO_OVERLAY
  if (!ownerOnline(slot.ownerKey)) return ABANDON.OFFLINE
  return null
}
