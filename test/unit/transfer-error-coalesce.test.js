import test from 'brittle'
import { createCoalescer } from '../../src/renderer/notifications/coalesce.js'

const WINDOW = 3000
const CAP = 10_000

function setup() {
  let t = 0
  const coalescer = createCoalescer({ windowMs: WINDOW, capMs: CAP, now: () => t })
  return { coalescer, advance: (ms) => { t += ms } }
}

// REGRESSION (FIX-447: one OS notification per file). A folder download into a read-only folder
// raised one critical notification per file; a burst of the same fault in one space is one
// notification, re-shown once with the count.
test('a burst of one fault in one space shows once, then settles with its count', (t) => {
  const { coalescer, advance } = setup()
  const shown = []
  for (let i = 0; i < 20; i++) {
    shown.push(coalescer.hit('s1:TRANSFER_PERMISSION'))
    advance(100)
  }
  t.is(shown.filter(Boolean).length, 1, 'only the first failure notifies at once')
  t.is(shown[0], true)
  t.is(coalescer.settle('s1:TRANSFER_PERMISSION'), null, 'still open inside the window')
  advance(WINDOW)
  t.is(coalescer.settle('s1:TRANSFER_PERMISSION'), 20)
  t.is(coalescer.settle('s1:TRANSFER_PERMISSION'), null, 'settled once')
})

test('another fault or another space is its own episode', (t) => {
  const { coalescer } = setup()
  t.is(coalescer.hit('s1:TRANSFER_PERMISSION'), true)
  t.is(coalescer.hit('s1:TRANSFER_DISK_FULL'), true)
  t.is(coalescer.hit('s2:TRANSFER_PERMISSION'), true)
  t.is(coalescer.hit('s1:TRANSFER_PERMISSION'), false)
})

test('a failure after the window closes starts a new episode', (t) => {
  const { coalescer, advance } = setup()
  coalescer.hit('s1:TRANSFER_PERMISSION')
  advance(WINDOW)
  t.is(coalescer.settle('s1:TRANSFER_PERMISSION'), 1, 'a lone failure settles with nothing to add')
  t.is(coalescer.hit('s1:TRANSFER_PERMISSION'), true)
})

test('the window resets per hit but closes at the cap', (t) => {
  const { coalescer, advance } = setup()
  coalescer.hit('s1:TRANSFER_PERMISSION')
  t.is(coalescer.closesAt('s1:TRANSFER_PERMISSION'), WINDOW)
  advance(2000)
  coalescer.hit('s1:TRANSFER_PERMISSION')
  t.is(coalescer.closesAt('s1:TRANSFER_PERMISSION'), 2000 + WINDOW, 'each hit extends the window')
  for (let at = 4000; at < CAP; at += 2000) {
    advance(2000)
    t.is(coalescer.hit('s1:TRANSFER_PERMISSION'), false)
  }
  t.is(coalescer.closesAt('s1:TRANSFER_PERMISSION'), CAP, 'continuous failures stop extending at the cap')
  advance(CAP)
  t.is(coalescer.hit('s1:TRANSFER_PERMISSION'), true, 'past the cap the next failure notifies again')
})
