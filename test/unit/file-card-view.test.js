import test from 'brittle'
import { deriveFileCardView } from '../../src/renderer/fileCardView.js'

const file = (o) => ({
  path: '/s/f', size: 100, hash: 'h', owner: { displayName: 'O', publicKey: 'k' },
  driveKey: 'd', localBytes: 0, isAvailable: true, status: 'remote', ...o,
})
const dec = (o) => ({ bytes: 0, total: 100, speed: 0, avgSpeed: 0, eta: null, ...o })
const summary = { spaceId: 's', path: '/s/f', peerKeys: ['p1'], pausedKeys: [], bytes: 0, total: 0, avgSpeed: 0 }

test('publishing wins the lane', (t) => {
  t.is(deriveFileCardView(file({ status: 'publishing' }), dec({ phase: 'publishing', bytes: 50 }), null).lane, 'publish')
})

test('a verify frame on a downloading row -> verify lane, displayStatus verifying', (t) => {
  const v = deriveFileCardView(file({ status: 'downloading' }), dec({ phase: 'verifying', verifyFraction: 0.5 }), null)
  t.is(v.lane, 'verify')
  t.is(v.displayStatus, 'verifying')
  t.is(v.verifyPct, 50)
})

test('downloading with bytes -> download lane; before first byte -> rest + displayStatus preparing', (t) => {
  t.is(deriveFileCardView(file({ status: 'downloading' }), dec({ bytes: 40, total: 100 }), null).lane, 'download')
  const waiting = deriveFileCardView(file({ status: 'downloading' }), dec({ bytes: 0 }), null)
  t.is(waiting.lane, 'rest')
  t.is(waiting.displayStatus, 'preparing')
})

test('a stale publish/prepare frame is ignored on a download row (cross-phase guard)', (t) => {
  const v = deriveFileCardView(file({ status: 'downloading' }), dec({ phase: 'publishing', bytes: 90 }), null)
  t.is(v.downloadDecor, null)
  t.is(v.lane, 'rest')
  t.is(v.displayStatus, 'preparing')
})

test('peer preparing paints only with a preparing decoration that has a total', (t) => {
  t.is(deriveFileCardView(file({ status: 'preparing' }), dec({ phase: 'preparing', bytes: 10, total: 100 }), null).lane, 'preparing')
  t.is(deriveFileCardView(file({ status: 'preparing' }), null, null).lane, 'rest')
})

test('sender indicator shows only when the row is otherwise at rest', (t) => {
  t.is(deriveFileCardView(file({ status: 'mine' }), null, summary).lane, 'indicator')
  t.is(deriveFileCardView(file({ status: 'mine' }), null, summary).indicatorActive, true)
  // a competing progress branch (our own download) takes precedence over the indicator
  const busy = deriveFileCardView(file({ status: 'downloading' }), dec({ bytes: 40, total: 100 }), summary)
  t.is(busy.lane, 'download')
  t.is(busy.indicatorActive, false)
})

test('paused rows render the partial from pendingBytes/size', (t) => {
  const v = deriveFileCardView(file({ status: 'paused-interrupted', pendingBytes: 30, size: 120 }), null, null)
  t.is(v.lane, 'download')
  t.is(v.downloadPct, 25)
  t.is(v.isDownloading, false)
})

test('verified badge only on a downloaded+verified file', (t) => {
  t.is(deriveFileCardView(file({ status: 'downloaded', verified: true }), null, null).showVerified, true)
  t.is(deriveFileCardView(file({ status: 'downloaded', verified: false }), null, null).showVerified, false)
  t.is(deriveFileCardView(file({ status: 'mine', verified: true }), null, null).showVerified, false)
})

test('publish percentage derives from the publish decoration', (t) => {
  const v = deriveFileCardView(file({ status: 'publishing' }), dec({ phase: 'publishing', bytes: 25, total: 100 }), null)
  t.is(v.publishPct, 25)
})
