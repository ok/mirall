import test from 'brittle'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { EventEmitter } from 'events'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

// Inject a fake chokidar so the watcher's event routing is driven synchronously (real fsevents
// timing + awaitWriteFinish make an fs-watch test flaky/slow). Each fake watcher is an
// EventEmitter we can emit on directly to simulate an add/change/unlink.
const created = []
const fakeChokidar = {
  watch () {
    const w = new EventEmitter()
    w.close = () => {}
    created.push(w)
    return w
  },
}
const chokidarPath = require.resolve('chokidar')
const prevChokidar = require.cache[chokidarPath]
require.cache[chokidarPath] = { id: chokidarPath, filename: chokidarPath, loaded: true, exports: fakeChokidar }
const modPath = require.resolve('../../src/main/owned-folder-watchers.js')
delete require.cache[modPath]
const { startWatcher, stopWatcher, stopAllWatchers } = require(modPath)
// Restore the real chokidar in the shared require cache — the module already captured the fake,
// so nothing else in a shared test process is affected.
if (prevChokidar) require.cache[chokidarPath] = prevChokidar
else delete require.cache[chokidarPath]

// REGRESSION (G3): after a worker "respawn" (a second startWatcher for the SAME shareId with a
// NEW callback), fs events must route to the NEW callback. Before the fix the has()-guard
// early-returned and the old (dead-worker) callback kept receiving events.
test('REGRESSION (G3): a re-armed watcher retargets to the newest callback', (t) => {
  created.length = 0
  const seenA = []; const seenB = []
  startWatcher('s1', '/mnt/x', [], (e) => seenA.push(e), () => {})
  t.is(created.length, 1, 'one watcher created')

  startWatcher('s1', '/mnt/x', [], (e) => seenB.push(e), () => {})   // worker #2 re-arms
  t.is(created.length, 1, 'no second watcher (has()-guard held)')

  created[0].emit('change', '/mnt/x/f.txt')   // an fs event on the surviving watcher

  t.is(seenB.length, 1, 'the new callback (worker #2) received the event')
  t.is(seenB[0].shareId, 's1')
  t.is(seenB[0].action, 'change')
  t.is(seenB[0].relPath, 'f.txt')
  t.is(seenA.length, 0, 'the stale callback (dead worker #1) received nothing after the re-arm')
  t.teardown(() => stopAllWatchers())
})

// The error callback retargets the same way (an error-storm on a re-armed watcher must reach
// the live worker, not the dead one).
test('G3: the error callback also retargets on re-arm', (t) => {
  created.length = 0
  const errA = []; const errB = []
  startWatcher('s2', '/mnt/y', [], () => {}, (e) => errA.push(e))
  startWatcher('s2', '/mnt/y', [], () => {}, (e) => errB.push(e))
  created[0].emit('error', new Error('boom'))
  t.is(errB.length, 1, 'newest error callback received it')
  t.is(errA.length, 0, 'stale error callback did not')
  t.teardown(() => stopAllWatchers())
})

// After a stop, a fresh arm creates a new watcher and routes to its callback.
test('G3: a stopped share re-arms cleanly', (t) => {
  created.length = 0
  const seen = []
  startWatcher('s3', '/mnt/z', [], () => {}, () => {})
  stopWatcher('s3')
  startWatcher('s3', '/mnt/z', [], (e) => seen.push(e), () => {})
  t.is(created.length, 2, 'a fresh watcher after stop')
  created[1].emit('add', '/mnt/z/g.txt')
  t.is(seen.length, 1, 'routed to the new callback')
  t.is(seen[0].action, 'add')
  t.teardown(() => stopAllWatchers())
})

// Deterministic backstop: the fix — re-point the shared emitter BEFORE the has()-guard — must
// stay in place so a future refactor can't reintroduce the stale per-worker binding.
test('G3 guard: startWatcher re-points the shared emitter before the has()-guard', (t) => {
  const src = readFileSync(join(here, '..', '..', 'src', 'main', 'owned-folder-watchers.js'), 'utf8')
  const body = src.match(/function startWatcher[\s\S]*?\n\}/)?.[0] || ''
  const assignIdx = body.indexOf('emitEvent = onEvent')
  const guardIdx = body.indexOf('watchers.has(shareId)')
  t.ok(assignIdx > -1, 'emitEvent is re-pointed to onEvent')
  t.ok(guardIdx > -1, 'the has()-guard is present')
  t.ok(assignIdx > -1 && guardIdx > -1 && assignIdx < guardIdx, 're-point precedes the guard')
  t.ok(/emitEvent\?\.\(/.test(body), 'the handler emits via the shared emitEvent ref')
})
