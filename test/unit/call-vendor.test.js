import test from 'brittle'
import { callVendor } from '../../src/shared/transfer/overlay/fetch-run.js'
import { capture } from '../helpers/capture-console.js'
import { setVerbose } from '../helpers/runtime-verbose.js'

// callVendor is the one vendor call the download engine and the mirror make while holding a fetch
// slot. Each outcome below is one the producers branch on: a landing, no holder, a rejection, and a
// stop after a scheduler ran. The diag comes back open on every one, and the caller closes it.

const HASH = 'h'.repeat(64)
const OPTS = { label: 'test', relPath: 'a.txt', size: 4, destPath: '/tmp/mirall-call-vendor-test' }

// A vendor that records what it was asked and settles as `behave` says, after optionally running
// the scheduler's end hook (which is what marks the fetch attempted).
function fakeVendor(behave, { schedulerRan = false } = {}) {
  const asked = []
  return {
    asked,
    fetchFile: async (hash, opts) => {
      asked.push({ hash, opts })
      if (schedulerRan) opts.onEnd({ reason: 'test', receivedBytes: 0, totalBytes: 4, totalChunks: 1, chunksRemaining: 1, peers: 1, elapsedMs: 0 })
      return behave()
    },
  }
}

// Verbose on, so the diag's start/terminal lines are all visible: a terminal line here would mean
// callVendor closed a diag whose outcome belongs to its caller.
function terminalLines(t) {
  setVerbose(t, true)
  const lines = capture(t, ['log', 'warn'])
  return () => [...lines.log, ...lines.warn].filter((l) => /a\.txt/.test(l) && !/ start: | scheduler end: /.test(l))
}

test('a landing resolves with the vendor result, no error and an open diag', async (t) => {
  const terminal = terminalLines(t)
  const landed = { destPath: OPTS.destPath }
  const vendor = fakeVendor(() => landed, { schedulerRan: true })
  const got = await callVendor(vendor, HASH, OPTS)
  t.is(got.res, landed, 'the vendor result unchanged')
  t.is(got.err, null)
  t.is(got.attempted, true, 'a scheduler ran')
  t.alike(terminal(), [], 'the diag is left for the caller to close')
  got.diag.finish('done')
  t.is(terminal().length, 1, 'and closing it is what logs the terminal line')
})

test('no holder resolves null and reads as never attempted', async (t) => {
  const got = await callVendor(fakeVendor(() => null), HASH, OPTS)
  t.is(got.res, null)
  t.is(got.err, null)
  t.is(got.attempted, false, 'no scheduler ever ran')
  t.ok(got.diag, 'the diag still comes back to be closed')
})

test('a rejection comes back as the error, never thrown', async (t) => {
  const terminal = terminalLines(t)
  const fault = Object.assign(new Error('disk error'), { code: 'ENOSPC' })
  const got = await callVendor(fakeVendor(() => { throw fault }), HASH, OPTS)
  t.is(got.err, fault, 'the very object the vendor rejected with')
  t.is(got.res, null)
  t.is(got.attempted, false)
  t.alike(terminal(), [], 'the outcome is the caller’s to choose')
})

// The rejection is returned, not annotated, so a fault that cannot carry a property still reaches
// the caller's fault policy as itself — the ENOSPC that has to pause a mount included.
test('a frozen rejection comes back unchanged, with its diag', async (t) => {
  const frozen = Object.freeze(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
  const got = await callVendor(fakeVendor(() => { throw frozen }), HASH, OPTS)
  t.is(got.err, frozen, 'the original object, not a TypeError from the call')
  t.is(got.err.code, 'ENOSPC')
  t.ok(got.diag, 'and the diag the caller closes')
})

test('a primitive rejection comes back unchanged', async (t) => {
  const got = await callVendor(fakeVendor(() => { throw 'overlay said no' }), HASH, OPTS)
  t.is(got.err, 'overlay said no', 'nothing in the call may swallow or rewrite it')
})

test('a fetch cancelled after its scheduler ran reads as attempted', async (t) => {
  const cancelled = Object.assign(new Error('cancelled'), { code: 'ECANCELLED' })
  const got = await callVendor(fakeVendor(() => { throw cancelled }, { schedulerRan: true }), HASH, OPTS)
  t.is(got.err, cancelled)
  t.is(got.attempted, true, 'a holder was asked before the stop')
})

test('the vendor gets every option but the instruments’, plus the wired callbacks', async (t) => {
  const ticks = []
  const progress = []
  const verified = []
  const vendor = fakeVendor(() => null)
  await callVendor(vendor, HASH, {
    ...OPTS, ownerKey: 'o'.repeat(64), parentMustExist: true,
    onProgress: (p) => progress.push(p.bytes), onTick: () => ticks.push(1), onVerify: (f) => verified.push(f),
  })
  const [{ hash, opts }] = vendor.asked
  t.is(hash, HASH)
  t.alike(
    { destPath: opts.destPath, size: opts.size, ownerKey: opts.ownerKey, parentMustExist: opts.parentMustExist },
    { destPath: OPTS.destPath, size: 4, ownerKey: 'o'.repeat(64), parentMustExist: true },
    'the vendor options pass through as given',
  )
  t.absent('label' in opts || 'relPath' in opts || 'onTick' in opts, 'the instruments’ own options stay out')
  opts.onProgress(2)
  opts.onVerify(0.5)
  t.alike(progress, [2], 'cumulative bytes reach the caller through the ticker')
  t.is(ticks.length, 1, 'and its tick')
  t.alike(verified, [0.5], 'and the verify callback is the caller’s')
})
