import test from 'brittle'
import { isTerminalFault, classifyMiss, nextRetryDelay } from '../../src/shared/transfer/backends/overlay/fetch-policy.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'

test('the terminal set is exactly the faults no retry can fix', (t) => {
  for (const c of [ErrorCodes.TRANSFER_CHECKSUM, ErrorCodes.TRANSFER_DISK_FULL, ErrorCodes.TRANSFER_DEST_UNAVAILABLE]) {
    t.ok(isTerminalFault(c), `${c} is terminal`)
  }
  for (const c of [ErrorCodes.TRANSFER_NETWORK, ErrorCodes.DOWNLOAD_FAILED, undefined, null, 'ECONNRESET']) {
    t.absent(isTerminalFault(c), `${String(c)} stays retryable`)
  }
})

test('a miss is classified by whether a scheduler ran', (t) => {
  t.is(classifyMiss({ attempted: false }), 'no-holder', 'nobody was ever reachable — a global fact')
  t.is(classifyMiss({ attempted: true }), 'failed', 'a holder was asked and died — a per-file fact')
})

test('backoff doubles, caps, and gives up on the dry budget', (t) => {
  const at = (dry) => nextRetryDelay({ dry, baseMs: 3000, maxMs: 12000, dryLimit: 3 })
  t.is(at(0), 3000)
  t.is(at(1), 6000)
  t.is(at(2), 12000)
  t.is(at(3), null, 'the budget is spent — park it')
  t.is(at(99), null)
})

test('the cap binds before the budget does', (t) => {
  t.is(nextRetryDelay({ dry: 5, baseMs: 3000, maxMs: 10000, dryLimit: 10 }), 10000,
    '3000 * 2^5 is 96000, capped to 10000')
})

// A zero budget means "never retry", not "retry immediately" — the fail-safe direction for a caller
// that wants the rule off.
test('a dryLimit of 0 refuses the first attempt', (t) => {
  t.is(nextRetryDelay({ dry: 0, baseMs: 1000, maxMs: 5000, dryLimit: 0 }), null)
})
