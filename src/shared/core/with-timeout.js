import { getRuntimeConfig } from './runtime-config.js'

// Bounds a best-effort async read against a wall-clock deadline. On timeout the
// returned promise resolves to `fallback` (it never rejects on timeout) — peer
// reads happen over the swarm, so a slow or offline peer must degrade to "no
// data from this peer" rather than block the caller. A read that resolves or
// rejects before the deadline passes through unchanged.
//
// Caveat: the underlying promise is abandoned, not cancelled — hyperbee/hypercore
// reads don't expose clean cancellation, so on timeout an in-flight block request
// is left to settle (or be GC'd) on its own. Only pass reads that are safe to
// leave dangling. This matches the existing `Promise.race([op, timeout])` idiom
// already used for peer-bee updates and avatar fetches.
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

// Budget for reading another peer's profile bee, comfortably under the renderer's
// 30 s IPC timeout so a single unreachable member can't stall an IPC (e.g.
// share:list, which fans out over every member) to the point of timing out.
// Sourced from runtime-config so tests can shrink it; defaults to 8 s.
export function peerReadTimeoutMs() {
  return getRuntimeConfig().peerReadTimeoutMs ?? 8000
}

// Read budget for the INTERACTIVE list fan-outs (files:list / share:list) — much shorter than
// peerReadTimeoutMs so a not-yet-replicated member can't freeze the list. The listing returns the
// locally-available rows and self-heals via event:shares-updated / event:files-updated once the
// peer's bee appends. Sourced from runtime-config so tests can shrink it; defaults to 1.5 s.
export function interactiveReadTimeoutMs() {
  return getRuntimeConfig().interactiveReadTimeoutMs ?? 1500
}
