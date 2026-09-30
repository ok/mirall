// How a fetch's coded errors are judged, stated once for the chunk scheduler and the facade.
//
// A code is the only signal. The scheduler attaches one only for a local filesystem fault (a
// write, the receive setup, the final rename) or a verdict (EHASHMISMATCH, ECANCELLED). An error
// without a code is a peer or transport outcome — stalled, map refused, every holder gone — which
// the caller reads as "no holder" and may retry.
//
// A write error with a transient code can clear by itself, so the scheduler keeps that chunk
// needed and reassigns it. A file that appeared at the target during the receive is retried too:
// the retry lands under a fresh name. Every other coded failure ends the fetch and reaches the
// caller unchanged: retrying the same holder cannot clear a full disk, a read-only or missing
// folder, a destination that is now a file, or an I/O error.

const TRANSIENT_WRITE_CODES = new Set(['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE'])
const RETRIED_CODES = new Set([...TRANSIENT_WRITE_CODES, 'ETARGETCHANGED'])
// Verdicts about the bytes or the fetch itself, as opposed to a fault of one destination.
const FETCH_VERDICTS = new Set(['EHASHMISMATCH', 'ECANCELLED'])

export function isTransientWriteCode (code) {
  return TRANSIENT_WRITE_CODES.has(code)
}

// True when a failed fetch must reach the caller as a rejection rather than as "no holder".
export function surfacesToCaller (err) {
  const code = err?.code
  return typeof code === 'string' && code !== '' && !RETRIED_CODES.has(code)
}

// True when a failed fetch ended on a fault of its own destination, which says nothing about
// another fetch of the same content into a different one.
export function isDestinationFault (err) {
  return surfacesToCaller(err) && !FETCH_VERDICTS.has(err.code)
}
