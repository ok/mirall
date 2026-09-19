// How long a request may run before the router says something about it. A single global bound would
// be wrong — space:leave answers at its own 12s deadline while the teardown behind it keeps going,
// and a preview scan or an export is bounded by the size of what the user pointed at, not by a
// number this file could pick. So the bound is per row, with a per-kind fallback, and 0 means
// deliberately unbounded.
//
// This is the WORKER's bound on how long work may run. It is not the renderer's bound on how long
// a person waits (ipc.ts DEFAULT_TIMEOUT), and the two are deliberately separate: the caller giving
// up does not mean the work should stop, and the work stopping is not something the caller learns
// from this. A caller that does give up sends a cancel, which is what usually ends the request
// first; this is the backstop for one that never does.
//
// The contract already classifies retry-safety, and that is the axis enforcement follows. A query
// is retry-safe, so its deadline ABORTS. A command may have written already, so its deadline only
// WARNS — aborting one mid-write risks exactly the half-states the durable-intent machinery exists
// to prevent.
/** @import { RequestSpec } from './requests.js' */

export const DEFAULT_DEADLINE_MS = Object.freeze({ query: 30000, command: 0 })

/** @param {RequestSpec | null | undefined} spec @returns {number} */
export function deadlineFor(spec) {
  if (!spec) return 0
  if (typeof spec.deadlineMs === 'number') return spec.deadlineMs
  return DEFAULT_DEADLINE_MS[spec.kind] ?? 0
}

/** @param {RequestSpec | null | undefined} spec @returns {'abort' | 'warn'} */
export function enforcementFor(spec) {
  return spec?.kind === 'query' ? 'abort' : 'warn'
}
