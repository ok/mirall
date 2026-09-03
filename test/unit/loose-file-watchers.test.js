import test from 'brittle'
import { loadWithFakeChokidar } from '../helpers/fake-chokidar.js'
import { withPlatform, UNC_PATH, NETWORK_CASES } from '../helpers/with-platform.js'

const { created, modules } = loadWithFakeChokidar(['src/main/watch-host.js', 'src/main/loose-file-watchers.js'])
const { addLooseWatch, removeLooseWatch, stopLooseWatchers } = modules[1]

function arm () {
  created.length = 0
  const events = []
  const errors = []
  return { events, errors, onEvent: (e) => events.push(e), onError: (e) => errors.push(e) }
}

const polling = () => created.filter((w) => w.opts.usePolling)
const native = () => created.filter((w) => !w.opts.usePolling)

// REGRESSION (FIX-PI3-1: a loose file shared from a network volume — /Volumes on macOS, /mnt or
// /media on Linux, a UNC path on Windows — got no watcher events at all, because the loose
// watcher had no polling fallback. The user edited the file, the app never noticed, and the
// stale version kept serving to every peer with no error and no badge. sweepLoosePresence was
// no backstop: it reclaims files that vanished, not files that merely changed.)
test('REGRESSION (FIX-PI3-1): a loose file on a network path is polled, and still fans out', (t) => {
  // Pinned per case: /Volumes is darwin-only and /mnt is linux-only, so a test that inherits the
  // machine's platform asserts nothing on the other one.
  for (const { platform, path, label } of NETWORK_CASES) {
    withPlatform(platform, () => {
      const { events, onEvent, onError } = arm()
      addLooseWatch('space-1', path, onEvent, onError)
      t.is(polling().length, 1, label + ' is watched by a polling instance')
      t.is(polling()[0].opts.interval, 5000, label + ' polls every 5s')
      polling()[0].emit('change', path)
      t.is(events.length, 1, label + ': the edit reached the worker')
      t.is(events[0].spaceId, 'space-1')
      t.is(events[0].action, 'change')
      stopLooseWatchers()
    })
  }
})

test('a local loose file still uses native events — no polling regression', (t) => {
  const { events, onEvent, onError } = arm()
  addLooseWatch('space-1', '/Users/me/notes.md', onEvent, onError)
  t.is(polling().length, 0, 'no polling instance for a local path')
  t.is(native().length, 1)
  native()[0].emit('change', '/Users/me/notes.md')
  t.is(events.length, 1)
  t.teardown(stopLooseWatchers)
})

test('local and network loose files coexist behind one host', (t) => {
  const { events, onEvent, onError } = arm()
  addLooseWatch('space-1', '/Users/me/notes.md', onEvent, onError)
  addLooseWatch('space-1', UNC_PATH, onEvent, onError)
  t.is(created.length, 2, 'two instances, one host')
  native()[0].emit('change', '/Users/me/notes.md')
  polling()[0].emit('change', UNC_PATH)
  t.alike(events.map((e) => e.absPath), ['/Users/me/notes.md', UNC_PATH])
  t.teardown(stopLooseWatchers)
})

test('one path shared in two spaces fans one event out to both', (t) => {
  const { events, onEvent, onError } = arm()
  addLooseWatch('space-1', '/Users/me/notes.md', onEvent, onError)
  addLooseWatch('space-2', '/Users/me/notes.md', onEvent, onError)
  t.is(created.length, 1, 'the path is armed once')
  t.alike(native()[0].targets, ['/Users/me/notes.md'], 'and added to chokidar once')
  native()[0].emit('change', '/Users/me/notes.md')
  t.alike(events.map((e) => e.spaceId).sort(), ['space-1', 'space-2'], 'both spaces were told')
  t.teardown(stopLooseWatchers)
})

test('removing one space keeps the watch while another space still holds it', (t) => {
  const { events, onEvent, onError } = arm()
  addLooseWatch('space-1', '/Users/me/notes.md', onEvent, onError)
  addLooseWatch('space-2', '/Users/me/notes.md', onEvent, onError)
  removeLooseWatch('space-1', '/Users/me/notes.md')
  t.alike(native()[0].targets, ['/Users/me/notes.md'], 'still watched')
  native()[0].emit('change', '/Users/me/notes.md')
  t.alike(events.map((e) => e.spaceId), ['space-2'], 'only the remaining space is told')
  t.teardown(stopLooseWatchers)
})

test('removing the last space unwatches the path', (t) => {
  const { events, onEvent, onError } = arm()
  addLooseWatch('space-1', '/Users/me/notes.md', onEvent, onError)
  removeLooseWatch('space-1', '/Users/me/notes.md')
  t.alike(native()[0].targets, [], 'unwatched')
  native()[0].emit('change', '/Users/me/notes.md')
  t.is(events.length, 0, 'a late event fans out to nobody')
  t.teardown(stopLooseWatchers)
})

test('removing a network path unwatches it on the polling instance', (t) => {
  const { onEvent, onError } = arm()
  addLooseWatch('space-1', UNC_PATH, onEvent, onError)
  removeLooseWatch('space-1', UNC_PATH)
  t.alike(polling()[0].targets, [], 'unwatched on the polling instance')
  t.teardown(stopLooseWatchers)
})

// REGRESSION (FIX-PI3-2: the loose watcher forwarded errors and did nothing else, so a watcher
// on a flaky mount spun for the life of the process. It now shares the owned side's cut-off.)
test('REGRESSION (FIX-PI3-2): a storm stops the host and clears the watched map', (t) => {
  const { events, errors, onEvent, onError } = arm()
  addLooseWatch('space-1', '/Users/me/notes.md', onEvent, onError)
  const stormed = created[0]
  for (let i = 0; i < 6; i++) stormed.emit('error', new Error('boom'))
  t.ok(/error-storm: watcher stopped for loose/.test(errors[errors.length - 1].message), 'the reason is reported')
  t.ok(stormed.closed, 'the instance was closed')

  // A fresh arm after a storm must build a clean host, not add to the dead one.
  addLooseWatch('space-1', '/Users/me/notes.md', onEvent, onError)
  t.is(created.length, 2, 'a new host was built')
  created[1].emit('change', '/Users/me/notes.md')
  t.is(events.length, 1, 'and it delivers')
  t.teardown(stopLooseWatchers)
})

test('stopLooseWatchers closes the host and forgets every path', (t) => {
  const { events, onEvent, onError } = arm()
  addLooseWatch('space-1', '/Users/me/notes.md', onEvent, onError)
  addLooseWatch('space-1', UNC_PATH, onEvent, onError)
  stopLooseWatchers()
  t.ok(created.every((w) => w.closed), 'both instances closed')
  created[0].emit('change', '/Users/me/notes.md')
  t.is(events.length, 0, 'a late event is dropped')

  addLooseWatch('space-1', '/Users/me/notes.md', onEvent, onError)
  t.is(created.length, 3, 'a later arm builds a fresh host')
  t.teardown(stopLooseWatchers)
})

test('a later arm re-points the callbacks (a respawned worker must receive the events)', (t) => {
  const first = arm()
  addLooseWatch('space-1', '/Users/me/notes.md', first.onEvent, first.onError)
  const second = { events: [] }   // a respawned worker's callbacks; do not reset `created` here
  addLooseWatch('space-2', '/Users/me/notes.md', (e) => second.events.push(e), () => {})
  created[0].emit('change', '/Users/me/notes.md')
  t.is(first.events.length, 0, 'the stale callback received nothing')
  t.is(second.events.length, 2, 'the newest callback received both spaces')
  t.teardown(stopLooseWatchers)
})
