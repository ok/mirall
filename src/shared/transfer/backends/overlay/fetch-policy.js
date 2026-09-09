// The rules every overlay fetch is judged by, whichever producer issued it. Pure, so each rule is
// asserted directly rather than through a live engine — the same shape as mirror-walk.js, and no
// bare-* imports so it unit-tests under Node.
//
// The download engine and the foreign-folder mirror answered all three of these separately, and
// drifted on the first: a checksum failure was terminal for the engine and retried on every tick by
// the mirror, which turned one bad holder into an unbounded, silent re-download loop.
import { ErrorCodes } from '../../../core/errors.js'

// A fault the user must clear before ANY retry can succeed. These are also exactly the codes
// runReconcile suppresses from auto-resume and the ones a channel surfaces to the user directly: the same holder serves the same bad
// bytes, a full disk is still full, an ejected volume is still gone. This is one set because it is
// one judgement — the engine's auto-resume suppression and the channel's user-facing error filter
// were separate copies of it, and the channel's own comment already said they were the same rule.
const TERMINAL = new Set([
  ErrorCodes.TRANSFER_CHECKSUM,
  ErrorCodes.TRANSFER_DISK_FULL,
  ErrorCodes.TRANSFER_DEST_UNAVAILABLE,
])

export function isTerminalFault(code) {
  return TERMINAL.has(code)
}

// A fetch that produced no file, classified by whether a chunk scheduler ever ran. `attempted`
// false means no holder was ever reachable — a process-global fact, so a caller walking a list may
// stop. True means a holder WAS asked and the transfer died, which is a fact about this file alone.
export function classifyMiss({ attempted }) {
  return attempted ? 'failed' : 'no-holder'
}

// How long before attempt N+1, and when to stop. `dry` counts consecutive attempts that banked no
// bytes; progress resets it, which is what lets a throttled transfer keep going one attempt at a
// time without exhausting a budget it never should have been charged.
export function nextRetryDelay({ dry, baseMs, maxMs, dryLimit }) {
  if (dry >= dryLimit) return null
  return Math.min(maxMs, baseMs * 2 ** dry)
}
