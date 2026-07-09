import test from 'brittle'
import { makeTabIntentTracker } from '../../src/renderer/tabIntent.js'

// REGRESSION (FIX-SKIP-1: revealing the hidden window from the tray made Chromium
// focus-advance to the skip link with no keyboard input, flashing "Skip to content"
// in the header on every reveal — synthetic focus must not count as tab intent).
test('REGRESSION (FIX-SKIP-1): focus with no prior Tab keydown is not tab intent', (t) => {
  const tracker = makeTabIntentTracker()
  t.is(tracker.isTabIntent(5000), false)
})

test('focus right after a Tab keydown is tab intent', (t) => {
  const tracker = makeTabIntentTracker()
  tracker.noteKeyDown('Tab', 1000)
  t.is(tracker.isTabIntent(1004), true)
})

test('non-Tab keys do not create tab intent', (t) => {
  const tracker = makeTabIntentTracker()
  tracker.noteKeyDown('a', 1000)
  tracker.noteKeyDown('Enter', 1001)
  t.is(tracker.isTabIntent(1002), false)
})

test('a stale Tab keydown does not create tab intent', (t) => {
  const tracker = makeTabIntentTracker()
  tracker.noteKeyDown('Tab', 1000)
  t.is(tracker.isTabIntent(2000), false)
})
