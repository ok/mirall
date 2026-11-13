import test from 'brittle'
import { fakeWatchEnv } from '../helpers/fake-watcher.js'
import { UNC_PATH, NETWORK_CASES } from '../helpers/with-platform.js'
import { createLooseFileWatchers } from '../../src/worker/watchers/loose-file-watchers.js'

let created = []

function arm({ platform } = {}) {
  const fake = fakeWatchEnv({ platform })
  created = fake.created
  const events = []
  const errors = []
  const loose = createLooseFileWatchers(fake.env, { onEvent: (e) => events.push(e), onError: (e) => errors.push(e) })
  return { events, errors, loose }
}

const polling = () => created.filter((w) => w.opts.usePolling)
const native = () => created.filter((w) => !w.opts.usePolling)

// REGRESSION (FIX-PI3-1: a loose file shared from a network volume — /Volumes on macOS, /mnt or
// /media on Linux, a UNC path on Windows — got no watcher events at all, because the loose
// watcher had no polling fallback. The user edited the file, the app never noticed, and the
// stale version kept serving to every peer with no error and no badge. sweepOwnedPresence was
// no backstop: it reclaims files that vanished, not files that merely changed.)
test('REGRESSION (FIX-PI3-1): a loose file on a network path is polled, and still fans out', (t) => {
  // Pinned per case: /Volumes is darwin-only and /mnt is linux-only, so a test that inherits the
  // machine's platform asserts nothing on the other one.
  for (const { platform, path, label } of NETWORK_CASES) {
    const { events, loose } = arm({ platform })
    loose.add('space-1', path)
    t.is(polling().length, 1, label + ' is watched by a polling instance')
    t.is(polling()[0].opts.interval, 5000, label + ' polls every 5s')
    polling()[0].emit('change', path)
    t.is(events.length, 1, label + ': the edit reached the data layer')
    t.is(events[0].spaceId, 'space-1')
    t.is(events[0].action, 'change')
    loose.stopAll()
  }
})

test('a local loose file still uses native events — no polling regression', (t) => {
  const { events, loose } = arm()
  loose.add('space-1', '/Users/me/notes.md')
  t.is(polling().length, 0, 'no polling instance for a local path')
  t.is(native().length, 1)
  native()[0].emit('change', '/Users/me/notes.md')
  t.is(events.length, 1)
  t.teardown(() => loose.stopAll())
})

test('local and network loose files coexist behind one host', (t) => {
  const { events, loose } = arm()
  loose.add('space-1', '/Users/me/notes.md')
  loose.add('space-1', UNC_PATH)
  t.is(created.length, 2, 'two instances, one host')
  native()[0].emit('change', '/Users/me/notes.md')
  polling()[0].emit('change', UNC_PATH)
  t.alike(events.map((e) => e.absPath), ['/Users/me/notes.md', UNC_PATH])
  t.teardown(() => loose.stopAll())
})

test('one path shared in two spaces fans one event out to both', (t) => {
  const { events, loose } = arm()
  loose.add('space-1', '/Users/me/notes.md')
  loose.add('space-2', '/Users/me/notes.md')
  t.is(created.length, 1, 'the path is armed once')
  t.alike(native()[0].targets, ['/Users/me/notes.md'], 'and added to the watcher once')
  native()[0].emit('change', '/Users/me/notes.md')
  t.alike(events.map((e) => e.spaceId).sort(), ['space-1', 'space-2'], 'both spaces were told')
  t.teardown(() => loose.stopAll())
})

test('removing one space keeps the watch while another space still holds it', (t) => {
  const { events, loose } = arm()
  loose.add('space-1', '/Users/me/notes.md')
  loose.add('space-2', '/Users/me/notes.md')
  loose.remove('space-1', '/Users/me/notes.md')
  t.alike(native()[0].targets, ['/Users/me/notes.md'], 'still watched')
  native()[0].emit('change', '/Users/me/notes.md')
  t.alike(events.map((e) => e.spaceId), ['space-2'], 'only the remaining space is told')
  t.teardown(() => loose.stopAll())
})

test('removing the last space unwatches the path', (t) => {
  const { events, loose } = arm()
  loose.add('space-1', '/Users/me/notes.md')
  loose.remove('space-1', '/Users/me/notes.md')
  t.alike(native()[0].targets, [], 'unwatched')
  native()[0].emit('change', '/Users/me/notes.md')
  t.is(events.length, 0, 'a late event fans out to nobody')
  t.teardown(() => loose.stopAll())
})

test('removing a network path unwatches it on the polling instance', (t) => {
  const { loose } = arm()
  loose.add('space-1', UNC_PATH)
  loose.remove('space-1', UNC_PATH)
  t.alike(polling()[0].targets, [], 'unwatched on the polling instance')
  t.teardown(() => loose.stopAll())
})

// REGRESSION (FIX-PI3-2: the loose watcher forwarded errors and did nothing else, so a watcher
// on a flaky mount spun for the life of the process. It now shares the owned side's cut-off.)
test('REGRESSION (FIX-PI3-2): a storm stops the host and clears the watched map', (t) => {
  const { events, errors, loose } = arm()
  loose.add('space-1', '/Users/me/notes.md')
  const stormed = created[0]
  for (let i = 0; i < 6; i++) stormed.emit('error', new Error('boom'))
  t.ok(/error-storm: watcher stopped for loose/.test(errors[errors.length - 1].message), 'the reason is reported')
  t.ok(stormed.closed, 'the instance was closed')

  // A fresh arm after a storm must build a clean host, not add to the dead one.
  loose.add('space-1', '/Users/me/notes.md')
  t.is(created.length, 2, 'a new host was built')
  created[1].emit('change', '/Users/me/notes.md')
  t.is(events.length, 1, 'and it delivers')
  t.teardown(() => loose.stopAll())
})

test('stopAll closes the host and forgets every path', (t) => {
  const { events, loose } = arm()
  loose.add('space-1', '/Users/me/notes.md')
  loose.add('space-1', UNC_PATH)
  loose.stopAll()
  t.ok(created.every((w) => w.closed), 'both instances closed')
  created[0].emit('change', '/Users/me/notes.md')
  t.is(events.length, 0, 'a late event is dropped')

  loose.add('space-1', '/Users/me/notes.md')
  t.is(created.length, 3, 'a later arm builds a fresh host')
  t.teardown(() => loose.stopAll())
})
