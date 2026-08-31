import { AppError, ErrorCodes } from './errors.js'

// The worker's cancellation token. A plain object with an `aborted` boolean, because AbortController
// is not a Bare global and three call sites already settled on this shape — walk-disk.js,
// publish-queue.js and the vendored prepareFile. Adopting it means every existing
// `if (signal?.aborted)` keeps working against a token that now also carries a reason and a
// subscription.
//
// `onAbort` exists for the one thing the ad-hoc version could not do: hand the abort to something
// that is BLOCKED rather than looping — a peer read parked on a socket cannot poll a boolean.
export function createCancellation() {
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: null,
    onAbort(fn) {
      if (signal.aborted) { fn(signal.reason); return () => {} }
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  return {
    signal,
    abort(reason = null) {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = reason
      // Isolated: one throwing listener must not stop the others from tearing their work down, and
      // must never surface as an unhandled rejection in the crash backstop's fault window — that
      // window exits the worker once it fills.
      for (const fn of listeners) { try { fn(reason) } catch {} }
      listeners.clear()
    },
  }
}

// Throws the abort's own reason when it carries one, so a cancellation initiated for a specific
// purpose keeps its message; otherwise the canonical ECANCELLED, which ipc.js already classifies as
// EXPECTED (logged at debug, not warn).
export function throwIfAborted(signal) {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new AppError(ErrorCodes.ECANCELLED, 'cancelled by the caller')
}
