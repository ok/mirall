import test from 'brittle'
import { runOverlayFetch } from '../../src/shared/transfer/backends/overlay/fetch-run.js'

const ARGS = { label: 'test', relPath: 'a.txt', size: 4, destPath: '/tmp/mirall-fetch-diag-test' }

const rejectingOverlay = (err) => ({ fetchFile: async () => { throw err } })

// The rejection VALUE is the subject here, not merely that it rejected, so it is captured rather
// than asserted through t.exception.
async function rejectionOf (thrown) {
  try {
    await runOverlayFetch(rejectingOverlay(thrown), 'h'.repeat(64), ARGS)
  } catch (err) { return err }
  throw new Error('runOverlayFetch resolved — the fake overlay always rejects')
}

test('a rejection carries the attempt flag and the diag its caller settles', async (t) => {
  const original = Object.assign(new Error('holder went away'), { code: 'ECANCELLED' })
  const err = await rejectionOf(original)
  t.is(err.code, 'ECANCELLED', 'the caller still sees its own fault')
  t.is(err.attempted, false, 'annotated with whether a scheduler ever ran')
  t.ok(err.diag, 'and with the diag, so the caller can settle the row it opened')
})

// REGRESSION (FIX-FETCH-ANNOTATE: the diag and the attempt flag were assigned onto the rejection
// unguarded. ESM is always strict, so a frozen or primitive rejection made those assignments throw
// a TypeError that REPLACED the real fault — a full disk would then reach the mirror as a bug in
// the instrumentation instead of the ENOSPC that has to pause the mount.)
test('REGRESSION (FIX-FETCH-ANNOTATE): a rejection that cannot be annotated still reaches its caller', async (t) => {
  const frozen = Object.freeze(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
  const err = await rejectionOf(frozen)
  t.is(err, frozen, 'the original object, not a TypeError from this file')
  t.is(err.code, 'ENOSPC', 'so the fault the mount must pause on survives')
})

test('a primitive rejection survives too', async (t) => {
  const err = await rejectionOf('overlay said no')
  t.is(err, 'overlay said no', 'nothing in the instrumentation may swallow or rewrite it')
})
