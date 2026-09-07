import test from 'brittle'
import { boundsOnSomeDisplay, usableBounds, MIN_VISIBLE } from '../../src/main/window-bounds.js'

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
const secondLeft = { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }

test('REGRESSION (FIX-BOUNDS-1): bounds on a display that is no longer attached are rejected', (t) => {
  // The shape a config.json carries after the user unplugs the external monitor they had the
  // window on. Electron does not clamp it, so the window opens where nothing can reach it.
  const stranded = { x: -3000, y: 200, width: 1200, height: 1000 }
  t.absent(boundsOnSomeDisplay(stranded, [primary]), 'off every attached display')
  t.alike(usableBounds(stranded, [primary]), { width: 1200, height: 1000 },
    'the size survives, the position does not')
})

test('the same bounds are kept while the display they were saved on is still attached', (t) => {
  // The pair the fix turns on: identical record, opposite verdict, decided only by what is plugged
  // in. Unplugging the left-hand monitor is what turns the first case into the second.
  const onSecond = { x: -1800, y: 100, width: 1200, height: 1000 }
  t.ok(boundsOnSomeDisplay(onSecond, [primary, secondLeft]), 'both attached')
  t.alike(usableBounds(onSecond, [primary, secondLeft]), onSecond, 'returned untouched')

  t.absent(boundsOnSomeDisplay(onSecond, [primary]), 'second display gone')
  t.alike(usableBounds(onSecond, [primary]), { width: 1200, height: 1000 }, 'position dropped')
})

test('a window straddling two displays counts as on-screen', (t) => {
  const straddling = { x: -400, y: 100, width: 1200, height: 900 }
  t.ok(boundsOnSomeDisplay(straddling, [primary, secondLeft]))
})

test('a rect overlapping only the very edge of a display does not count', (t) => {
  // One pixel of a title bar is not something a user can grab.
  const sliver = { x: 1920 - 1, y: 100, width: 1200, height: 900 }
  t.absent(boundsOnSomeDisplay(sliver, [primary]), 'one column of pixels is not reachable')

  const justUnder = { x: 1920 - (MIN_VISIBLE - 1), y: 100, width: 1200, height: 900 }
  t.absent(boundsOnSomeDisplay(justUnder, [primary]), 'just under the threshold is refused')

  const justOver = { x: 1920 - MIN_VISIBLE, y: 100, width: 1200, height: 900 }
  t.ok(boundsOnSomeDisplay(justOver, [primary]), 'the threshold itself is accepted')
})

test('a rect off the bottom edge is refused even though it overlaps horizontally', (t) => {
  // Both axes have to clear the threshold: a window dragged below the dock is as unreachable as
  // one dragged off the side, and checking only width would pass it.
  const belowScreen = { x: 200, y: 1080 - 10, width: 1200, height: 900 }
  t.absent(boundsOnSomeDisplay(belowScreen, [primary]))
})

test('a window hanging off the TOP is refused however much of its body shows', (t) => {
  // The case a symmetric overlap test lets through: 100px of this window is on the primary
  // display, comfortably over the threshold — but all of it is body. The title bar, the only part
  // that can be dragged, is 800px above the top of the screen.
  const above = { workArea: { x: 0, y: -1080, width: 1920, height: 1080 } }
  const onUpperDisplay = { x: 200, y: -800, width: 1200, height: 900 }

  t.ok(boundsOnSomeDisplay(onUpperDisplay, [primary, above]), 'fine while the upper display is attached')
  t.absent(boundsOnSomeDisplay(onUpperDisplay, [primary]), 'unreachable once it is unplugged')
  t.alike(usableBounds(onUpperDisplay, [primary]), { width: 1200, height: 900 })
})

test('a window whose top edge is one pixel above the work area is refused', (t) => {
  t.absent(boundsOnSomeDisplay({ x: 200, y: -1, width: 1200, height: 900 }, [primary]))
  t.ok(boundsOnSomeDisplay({ x: 200, y: 0, width: 1200, height: 900 }, [primary]),
    'flush with the top is fine')
})

test('a display with no workArea is skipped rather than throwing', (t) => {
  const bounds = { x: 100, y: 100, width: 800, height: 600 }
  t.absent(boundsOnSomeDisplay(bounds, [{}, null]), 'nothing usable to compare against')
  t.ok(boundsOnSomeDisplay(bounds, [{}, primary]), 'and a good one alongside still matches')
})

test('a missing bounds record stays missing', (t) => {
  t.absent(boundsOnSomeDisplay(null, [primary]))
  t.is(usableBounds(null, [primary]), null)
})

test('a missing display list is refused rather than treated as "anywhere is fine"', (t) => {
  const bounds = { x: 100, y: 100, width: 800, height: 600 }
  t.absent(boundsOnSomeDisplay(bounds, undefined))
})
