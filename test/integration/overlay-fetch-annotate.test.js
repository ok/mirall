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

// Warnings, not the diag object: `INCOMPLETE … gave up` IS the artifact — the one line that closes
// the `start:` line every fetch logs — and the diag exposes no readable state.
function captureWarnings (t) {
  const lines = []
  const real = console.warn
  console.warn = (...args) => lines.push(args.join(' '))
  t.teardown(() => { console.warn = real })
  return lines
}

// REGRESSION (FIX-FETCH-DIAG: when the annotation could not land, the diag was dropped rather than
// settled. Every caller reaches it through `err.diag`, so `diag?.finish('failed')` no-opped and the
// `start:` line this fetch had already logged never got its terminal `INCOMPLETE … gave up` —
// losing the give-up record for exactly the frozen-rejection ENOSPC case the annotation guard was
// added for.)
test('REGRESSION (FIX-FETCH-DIAG): a rejection that cannot be annotated still closes its diag', async (t) => {
  const warnings = captureWarnings(t)
  const frozen = Object.freeze(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
  const err = await rejectionOf(frozen)
  t.is(err, frozen, 'the fault still reaches the caller unchanged')
  t.ok(warnings.some((line) => line.includes('INCOMPLETE') && line.includes('a.txt')),
    'and the give-up is on the record, because nothing downstream could have reached this diag')
})

// The other half of the rule, and the reason the fix is conditional rather than a finish() in the
// catch: when the annotation DID land, the outcome is the caller's to choose. The mirror settles an
// ECANCELLED as 'paused', which is normal control flow — pre-empting it here would turn every
// pause and unmount into a logged give-up.
test('an annotatable rejection is left for its caller to settle', async (t) => {
  const warnings = captureWarnings(t)
  const err = await rejectionOf(Object.assign(new Error('holder went away'), { code: 'ECANCELLED' }))
  t.ok(err.diag, 'the caller got the diag')
  t.alike(warnings, [], 'and this file did not decide the outcome on its behalf')
})
