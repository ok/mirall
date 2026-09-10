import { getRuntimeConfig } from './runtime-config.js'

// Bounds a best-effort async read against a wall-clock deadline. On timeout the
// returned promise resolves to `fallback` (it never rejects on timeout) — peer
// reads happen over the swarm, so a slow or offline peer must degrade to "no
// data from this peer" rather than block the caller. A read that resolves or
// rejects before the deadline passes through unchanged.
//
// Caveat: the underlying promise is abandoned, not cancelled — hyperbee/hypercore reads expose no
// clean cancellation, so on timeout an in-flight block request is left to settle on its own. Only
// pass reads that are safe to leave dangling.
export function withReadTimeout(promise, ms, fallback) {
  let timer
  const p = Promise.resolve(promise)
  // Swallow a late rejection that lands after the timeout already won the race,
  // so it can't surface as an unhandledRejection.
  p.catch(() => {})
  // Not unref'd: while the read is in-flight the deadline is genuine pending
  // work and should keep the loop alive until it settles (the .finally clears it
  // the moment the race resolves either way). Worker shutdown force-exits via
  // Bare.exit, so this never delays teardown.
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

// The budget left until `deadlineAt`, never negative: an inner read that follows one that
// already spent part of the caller's allowance derives its own bound from this, so one
// deadline covers the whole sequence instead of each step charging the full budget again.
export function remainingMs(deadlineAt, now = Date.now()) {
  return Math.max(0, deadlineAt - now)
}

// Budget for reading another peer's profile bee; sized in runtime-config.js.
export function peerReadTimeoutMs() {
  return getRuntimeConfig().peerReadTimeoutMs ?? 8000
}

// Read budget for the INTERACTIVE list fan-outs (files:list / share:list); sized in runtime-config.js.
export function interactiveReadTimeoutMs() {
  return getRuntimeConfig().interactiveReadTimeoutMs ?? 1500
}
