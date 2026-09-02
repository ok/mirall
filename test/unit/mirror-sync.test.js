import test from 'brittle'
import { deriveMirrorSync } from '../../src/renderer/mirrorSync.js'

const file = (status, size, extra = {}) => ({ relPath: status + size, size, hash: 'h', mtime: 0, status, ...extra })

test('a settled mirror reports no work', (t) => {
  const summary = deriveMirrorSync([file('downloaded', 100), file('synced', 50)])
  t.is(summary.active, false)
  t.is(summary.files, 0)
  t.is(summary.onDevice, 2)
  t.is(summary.pct, null, 'no bar for a folder that is not moving')
})

test('an empty listing is not active', (t) => {
  t.is(deriveMirrorSync([]).active, false)
})

// A mirror fetches ONE file at a time, so counting 'downloading' rows would say "1 file" for a
// 5,000-file folder and flicker to zero between every file. What the user is waiting for is what
// is not here yet.
test('the count is what is still missing, not what is moving', (t) => {
  const summary = deriveMirrorSync([
    file('downloading', 100, { progress: { bytes: 40, total: 100, speed: 0 } }),
    file('remote', 60),
    file('remote', 40),
    file('downloaded', 200),
  ])
  t.is(summary.active, true)
  t.is(summary.files, 3, 'one in flight plus the two queued behind it')
  t.is(summary.onDevice, 1)
  t.is(summary.bytesRemaining, 160, '60 left on the moving file, then 60 and 40')
})

// 'preparing' means the OWNER has not hashed that entry yet. It is still a file we do not have, so
// it counts as pending — but it must not be mistaken for bytes in flight.
test('an unhashed row counts as pending, not as a transfer', (t) => {
  const summary = deriveMirrorSync([file('preparing', 500), file('downloaded', 500)])
  t.is(summary.files, 1)
  t.is(summary.bytesRemaining, 500)
})

test('a paused row contributes what it already has', (t) => {
  const summary = deriveMirrorSync([file('downloading', 100, { pendingBytes: 25 })])
  t.is(summary.bytesRemaining, 75, 'pendingBytes stands in when there is no live progress')
})

test('progress is measured against the whole folder, not the queue', (t) => {
  const summary = deriveMirrorSync([
    file('downloaded', 750),
    file('remote', 250),
  ])
  t.is(summary.pct, 75, 'three quarters of the bytes are already here')
  t.is(summary.indeterminate, false)
})

test('bytes already pulled into a partial count towards the bar', (t) => {
  const summary = deriveMirrorSync([file('downloading', 1000, { progress: { bytes: 500, total: 1000, speed: 0 } })])
  t.is(summary.pct, 50)
})

// Past the cap the rows are a capped sample, so bytes-on-device over bytes-total would be computed
// from a subset and read low. An honest sweep beats a wrong number.
test('a truncated listing drops the percentage instead of guessing', (t) => {
  const summary = deriveMirrorSync([file('downloading', 100), file('downloaded', 100)], { truncated: true })
  t.is(summary.active, true)
  t.is(summary.pct, null)
  t.is(summary.indeterminate, true)
})

test('a paused mirror is not working, however many files it still lacks', (t) => {
  const summary = deriveMirrorSync([file('remote', 100), file('remote', 100)], { enabled: false })
  t.is(summary.active, false)
  t.is(summary.files, 0)
  t.is(summary.onDevice, 0, 'but the on-device count is still honest')
})

test('a folder with no bytes at all cannot report a percentage', (t) => {
  const summary = deriveMirrorSync([file('remote', 0)])
  t.is(summary.pct, null)
  t.is(summary.indeterminate, true)
})

test('a size that is not a number never poisons the totals', (t) => {
  const summary = deriveMirrorSync([
    { relPath: 'x', size: undefined, hash: 'h', mtime: 0, status: 'remote' },
    file('downloaded', 100),
  ])
  t.is(summary.bytesRemaining, 0)
  t.is(summary.pct, 100)
})
