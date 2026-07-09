import test from 'brittle'
import { MAIN_REQUEST_MAX_LINE, isControlFrameCandidate } from '../../src/main/ipc-frame.js'

// REGRESSION (FIX-143): main parsed EVERY worker→main pipe line with JSON.parse just to detect
// tiny 'main-request' control frames — so a multi-MB worker→renderer listing response blocked
// main's UI thread on a giant parse. isControlFrameCandidate gates by size so large frames are
// skipped (they're already broadcast to the renderer), while small control frames still parse.
test('REGRESSION (FIX-143): only small lines are control-frame candidates', (t) => {
  t.is(isControlFrameCandidate(''), false, 'empty line is not a frame')
  t.is(isControlFrameCandidate(JSON.stringify({ type: 'main-request', command: 'owned-folder:start-watcher' })), true, 'a real control frame qualifies')
  t.is(isControlFrameCandidate('x'.repeat(MAIN_REQUEST_MAX_LINE)), true, 'exactly at the limit qualifies')
  t.is(isControlFrameCandidate('x'.repeat(MAIN_REQUEST_MAX_LINE + 1)), false, 'one over the limit is skipped (a large listing response)')
})
