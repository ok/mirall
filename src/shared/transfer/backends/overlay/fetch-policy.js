// The rules every overlay fetch is judged by, whichever producer issued it. Pure, so each rule is
// asserted directly rather than through a live engine — the same shape as mirror-walk.js, and no
// bare-* imports so it unit-tests under Node.
import { CODES } from '../../../contract/errors.js'
import { FETCH_OUTCOME } from './fetch-outcome.js'

// A fault the user must clear before ANY retry can succeed: the same holder serves the same bad
// bytes, a full disk is still full, an ejected volume is still gone, a folder we may not write is
// still read-only. One set because it is one judgement, and every producer and channel that judges
// a fault reads it.
const TERMINAL = new Set([
  CODES.TRANSFER_CHECKSUM,
  CODES.TRANSFER_DISK_FULL,
  CODES.TRANSFER_DEST_UNAVAILABLE,
  CODES.TRANSFER_PERMISSION,
])

export function isTerminalFault(code) {
  return TERMINAL.has(code)
}

// A fetch that produced no file, classified by whether a chunk scheduler ever ran. `attempted`
// false means no holder was ever reachable — a process-global fact, so a caller walking a list may
// stop. True means a holder WAS asked and the transfer died, which is a fact about this file alone.
export function classifyMiss({ attempted }) {
  return attempted ? FETCH_OUTCOME.FAILED : FETCH_OUTCOME.NO_HOLDER
}

// How long before attempt N+1, and when to stop. `dry` counts consecutive attempts that banked no
// bytes; progress resets it, which is what lets a throttled transfer keep going one attempt at a
// time without exhausting a budget it never should have been charged.
export function nextRetryDelay({ dry, baseMs, maxMs, dryLimit }) {
  if (dry >= dryLimit) return null
  return Math.min(maxMs, baseMs * 2 ** dry)
}
