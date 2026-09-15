// Validation rules a getter applies when it reads a key. Each takes the raw override, the key's
// tabled default and an optional bound, and returns a value the caller may act on. A rule never
// throws and never returns undefined: the alternative is a worker that dies on a malformed
// bootstrap frame.

function isFiniteAtLeast(value, min) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min
}

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// A budget that is multiplied by a live count, or divided into an elapsed time, must be finite and
// within its bound: Infinity yields NaN against a zero count (which reads as "lane disabled" and
// fails OPEN), a negative yields a cap no frame can meet (fails closed on honest peers).
export function finiteAtLeast(value, fallback, min) {
  return isFiniteAtLeast(value, min) ? value : fallback
}

// A slot count: the same admission, floored, because a fractional slot is not one.
export function intAtLeast(value, fallback, min) {
  return isFiniteAtLeast(value, min) ? Math.floor(value) : fallback
}

// intAtLeast with an explicit Infinity honoured as "unbounded". The asymmetry with intAtLeast is the
// whole reason these are two rules rather than one with two minima: on the publish lane Infinity
// means "run every item at once", while on the download gate 0 already means that — so an Infinity
// there is a malformed value, and admitting it would quietly unbound the gate.
export function intAtLeastOrInfinity(value, fallback, min) {
  return value === Infinity ? Infinity : intAtLeast(value, fallback, min)
}

// A protective bound that fails SAFE: an explicit 0 or Infinity disables the cap (returned as
// Infinity so callers can compare freely), a positive finite number is honoured, and anything else
// falls back to the default rather than silently disabling the cap.
export function capOrInfinity(value, fallback) {
  if (value === 0 || value === Infinity) return Infinity
  return isPositiveFinite(value) ? value : fallback
}

// capOrInfinity with the two sentinels kept DISTINCT: this bounds worker memory, so 0 means "no
// cache" and never "no bound", and Infinity means unbounded. A corrupt value falls back to the
// default rather than to either extreme.
export function boundedOrSentinel(value, fallback) {
  if (value === 0 || value === Infinity) return value
  return isPositiveFinite(value) ? value : fallback
}

// The inverted polarity: a user convenience rather than a protective bound, so a corrupt value
// returns to UNLIMITED (0) instead of throttling every transfer to a crawl. The tabled default is
// deliberately not consulted.
export function failOpen(value) {
  return isPositiveFinite(value) ? value : 0
}
