import test from 'brittle'
import { deriveRowView, rowBytesOnDevice } from '../../src/renderer/rowView.js'

const file = (o) => ({
  path: '/s/f', size: 100, hash: 'h', owner: { displayName: 'O', publicKey: 'k' },
  driveKey: 'd', localBytes: 0, isAvailable: true, status: 'remote', ...o,
})
const dec = (o) => ({ bytes: 0, total: 100, speed: 0, avgSpeed: 0, eta: null, ...o })
const summary = { spaceId: 's', path: '/s/f', peerKeys: ['p1'], pausedKeys: [], bytes: 0, total: 0, avgSpeed: 0 }

test('publishing wins the lane', (t) => {
  t.is(deriveRowView(file({ status: 'publishing' }), dec({ phase: 'publishing', bytes: 50 }), null).lane, 'publish')
})

test('a verify frame on a downloading row -> verify lane, displayStatus verifying', (t) => {
  const v = deriveRowView(file({ status: 'downloading' }), dec({ phase: 'verifying', verifyFraction: 0.5 }), null)
  t.is(v.lane, 'verify')
  t.is(v.displayStatus, 'verifying')
  t.is(v.verifyPct, 50)
})

test('downloading with bytes -> download lane; before first byte -> rest + displayStatus preparing', (t) => {
  t.is(deriveRowView(file({ status: 'downloading' }), dec({ bytes: 40, total: 100 }), null).lane, 'download')
  const waiting = deriveRowView(file({ status: 'downloading' }), dec({ bytes: 0 }), null)
  t.is(waiting.lane, 'rest')
  t.is(waiting.displayStatus, 'preparing')
})

test('a stale publish/prepare frame is ignored on a download row (cross-phase guard)', (t) => {
  const v = deriveRowView(file({ status: 'downloading' }), dec({ phase: 'publishing', bytes: 90 }), null)
  t.is(v.downloadDecor, null)
  t.is(v.lane, 'rest')
  t.is(v.displayStatus, 'preparing')
})

test('peer preparing paints only with a preparing decoration that has a total', (t) => {
  t.is(deriveRowView(file({ status: 'preparing' }), dec({ phase: 'preparing', bytes: 10, total: 100 }), null).lane, 'preparing')
  t.is(deriveRowView(file({ status: 'preparing' }), null, null).lane, 'rest')
})

test('sender indicator shows only when the row is otherwise at rest', (t) => {
  t.is(deriveRowView(file({ status: 'mine' }), null, summary).lane, 'indicator')
  t.is(deriveRowView(file({ status: 'mine' }), null, summary).indicatorActive, true)
  // a competing progress branch (our own download) takes precedence over the indicator
  const busy = deriveRowView(file({ status: 'downloading' }), dec({ bytes: 40, total: 100 }), summary)
  t.is(busy.lane, 'download')
  t.is(busy.indicatorActive, false)
})

test('paused rows render the partial from pendingBytes/size', (t) => {
  const v = deriveRowView(file({ status: 'paused-interrupted', pendingBytes: 30, size: 120 }), null, null)
  t.is(v.lane, 'download')
  t.is(v.downloadPct, 25)
  t.is(v.isDownloading, false)
})

test('verified badge only on a downloaded+verified file', (t) => {
  t.is(deriveRowView(file({ status: 'downloaded', verified: true }), null, null).showVerified, true)
  t.is(deriveRowView(file({ status: 'downloaded', verified: false }), null, null).showVerified, false)
  t.is(deriveRowView(file({ status: 'mine', verified: true }), null, null).showVerified, false)
})

test('publish percentage derives from the publish decoration', (t) => {
  const v = deriveRowView(file({ status: 'publishing' }), dec({ phase: 'publishing', bytes: 25, total: 100 }), null)
  t.is(v.publishPct, 25)
})

const shareRow = (o) => ({ relPath: 'a/b.txt', size: 100, hash: 'h', mtime: 0, status: 'remote', ...o })
const view = (row, decoration, downloadSummary, opts) => deriveRowView(row, decoration, downloadSummary, opts)

test('both kinds take the same lane for the same shape', (t) => {
  const d = dec({ bytes: 40, total: 100, eta: 5 })
  t.is(view(file({ status: 'downloading' }), d, null, { kind: 'loose' }).lane, 'download')
  t.is(view(shareRow({ status: 'downloading' }), d, null, { kind: 'share' }).lane, 'download')
})

test('kind selects only the badge table', (t) => {
  // 'synced' is share-only and collapses to the `mine` pill on our own share.
  t.is(view(shareRow({ status: 'synced' }), null, null, { kind: 'share', isOwn: true }).badge.labelKey, 'status.mine')
  t.is(view(shareRow({ status: 'synced' }), null, null, { kind: 'share', isOwn: false }).badge.labelKey, 'status.downloaded')
  t.is(view(file({ status: 'mine' }), null, null, { kind: 'loose' }).badge.labelKey, 'status.mine')
})

test('REGRESSION (FIX-RV-2: a publishing row shows a bar before its first frame, on BOTH kinds)', (t) => {
  // The share row gated this on a decoration and fell through to a bare pill; the loose row did not.
  for (const [kind, row] of [['loose', file({ status: 'publishing' })], ['share', shareRow({ status: 'publishing' })]]) {
    const v = view(row, null, null, { kind })
    t.is(v.lane, 'publish', `${kind} takes the publish lane with no decoration`)
    t.is(v.publishDecor, null, `${kind} has nothing to measure, so the bar is indeterminate`)
  }
})

test('REGRESSION (FIX-RV-3: a just-requested download reports movement, on BOTH kinds)', (t) => {
  for (const [kind, mk] of [['loose', file], ['share', shareRow]]) {
    const fresh = view(mk({ status: 'downloading', pendingBytes: 0, size: 100 }), null, null, { kind, seeded: true })
    t.is(fresh.displayStatus, 'preparing', `${kind}: nothing transferred yet reads as preparing`)
    const resumed = view(mk({ status: 'downloading', pendingBytes: 40, size: 100 }), null, null, { kind, seeded: true })
    t.is(resumed.lane, 'download', `${kind}: a resumed partial paints immediately`)
    t.is(resumed.downloadPct, 40)
    // eta null is what makes the bar read "Estimating…" rather than freeze at a static value.
    t.is(resumed.downloadDecor.eta, null)
    const peer = view(mk({ status: 'preparing', size: 100 }), null, null, { kind, seeded: true })
    t.is(peer.lane, 'preparing', `${kind}: a seeded preparing row shows the owner's hash is pending`)
  }
})

test('a real frame outranks the seed', (t) => {
  const v = view(shareRow({ status: 'downloading', pendingBytes: 10, size: 100 }),
    dec({ bytes: 70, total: 100, eta: 3 }), null, { kind: 'share', seeded: true })
  t.is(v.downloadPct, 70)
})

test('the seed never applies outside the transfer states', (t) => {
  for (const s of ['remote', 'unavailable', 'error', 'synced', 'downloaded', 'publishing']) {
    t.is(view(shareRow({ status: s }), null, null, { kind: 'share', seeded: true }).downloadDecor, null, s)
  }
})

test('a seeded row with no size has nothing to measure', (t) => {
  const v = view(shareRow({ status: 'downloading', size: 0 }), null, null, { kind: 'share', seeded: true })
  t.is(v.downloadDecor, null)
  t.is(v.lane, 'rest')
})

test('verified check covers a mirror row, not just a downloaded one', (t) => {
  t.is(view(shareRow({ status: 'synced', verified: true }), null, null, { kind: 'share' }).showVerified, true)
  t.is(view(shareRow({ status: 'downloading', verified: true }), null, null, { kind: 'share' }).showVerified, false)
})

// What a mirror counts as already here. The decoration key is shared across phases, so the rule
// has to be narrower than "whatever frame this path has": a hash frame measures the OWNER walking
// the file, and a frame left on a row that has moved on is stale. Either one counted as bytes
// would make deriveMirrorSync report a whole un-fetched file as done.
test('bytes-on-device counts a transfer frame, never a hash or a stale one', (t) => {
  const row = (o) => shareRow({ size: 100, pendingBytes: 10, ...o })
  t.is(rowBytesOnDevice(row({ status: 'downloading' }), dec({ bytes: 60 })), 60, 'a live download frame wins')
  t.is(rowBytesOnDevice(row({ status: 'downloading' }), dec({ bytes: 60, phase: 'verifying' })), 60, 'so does its verify sub-phase')
  t.is(rowBytesOnDevice(row({ status: 'downloading' }), dec({ bytes: 95, phase: 'preparing' })), 10,
    'the owner hashing the file is not bytes on this device')
  t.is(rowBytesOnDevice(row({ status: 'preparing' }), dec({ bytes: 95, phase: 'preparing' })), 10, 'nor on a preparing row')
  t.is(rowBytesOnDevice(row({ status: 'remote' }), dec({ bytes: 95 })), 10, 'a frame left on a row that moved on is stale')
  t.is(rowBytesOnDevice(row({ status: 'paused-interrupted' }), null), 10, 'a paused row reports its durable partial')
  t.is(rowBytesOnDevice(shareRow({ status: 'remote', size: 100 }), null), 0, 'and an untouched row reports nothing')
})
