// The closed vocabulary of fetch outcomes — every value `diag.finish()` accepts, in one place.
//
// It lives in its own module, and imports nothing, for two reasons: `fetch-policy.js` produces
// outcomes and must stay free of `bare-*` so test/unit can load it under Node, and `makeFetchDiag`
// (overlay-backend.js) consumes them, so a shared home is the only one that is not a cycle.
//
// Before this existed the producers spelled their outcomes as literals and the diag kept a
// hand-written set of the ones it recognised. The two drifted: 'awaiting-republish' — a normal,
// documented park while the owner re-hashes a source — was never added to the set, so every park
// logged a WARN "INCOMPLETE … gave up" into the user's log and every diagnostics bundle.
export const FETCH_OUTCOME = Object.freeze({
  DONE: 'done',
  FAILED: 'failed',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  SUPERSEDED: 'superseded',
  NO_HOLDER: 'no-holder',
  AWAITING_REPUBLISH: 'awaiting-republish',
})

// Derived, never re-listed: exactly two outcomes are terminal for the intent — the success and the
// give-up — and everything else is control flow the user or the owner asked for. An outcome added
// to the vocabulary above is therefore a deliberate stop by default; if a future one is a genuine
// give-up, it belongs beside FAILED here rather than in a second list.
export const DELIBERATE_STOPS = new Set(
  Object.values(FETCH_OUTCOME).filter((o) => o !== FETCH_OUTCOME.DONE && o !== FETCH_OUTCOME.FAILED),
)
