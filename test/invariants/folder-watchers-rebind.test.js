import test from 'brittle'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { loadWithFakeChokidar } from '../helpers/fake-chokidar.js'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', '..', 'src', 'main', 'folder-watchers.js')

// chokidar is stubbed (see the helper) so the watcher's event routing is driven synchronously:
// real fsevents timing plus awaitWriteFinish makes an fs-watch test slow and flaky.
const { created, modules } = loadWithFakeChokidar(['src/main/watch-host.js', 'src/main/folder-watchers.js'])
const { startWatcher, stopWatcher, stopAllWatchers } = modules[1]

// REGRESSION (G3): after a worker "respawn" (a second startWatcher for the SAME key with a NEW
// callback), fs events must route to the NEW callback. Before the fix the has()-guard
// early-returned and the old (dead-worker) callback kept receiving events.
test('REGRESSION (G3): a re-armed watcher retargets to the newest callback', async (t) => {
  created.length = 0
  const seenA = []; const seenB = []
  await startWatcher('s1', '/mnt/x', [], (e) => seenA.push(e), () => {})
  t.is(created.length, 1, 'one watcher created')

  await startWatcher('s1', '/mnt/x', [], (e) => seenB.push(e), () => {})   // worker #2 re-arms
  t.is(created.length, 1, 'no second watcher (has()-guard held)')

  created[0].emit('change', '/mnt/x/f.txt')   // an fs event on the surviving watcher

  t.is(seenB.length, 1, 'the new callback (worker #2) received the event')
  t.alike(seenB[0], { action: 'change', relPath: 'f.txt', absPath: '/mnt/x/f.txt' })
  t.is(seenA.length, 0, 'the stale callback (dead worker #1) received nothing after the re-arm')
  t.teardown(() => stopAllWatchers())
})

// The error callback retargets the same way (an error-storm on a re-armed watcher must reach
// the live worker, not the dead one).
test('G3: the error callback also retargets on re-arm', async (t) => {
  created.length = 0
  const errA = []; const errB = []
  await startWatcher('s2', '/mnt/y', [], () => {}, (e) => errA.push(e))
  await startWatcher('s2', '/mnt/y', [], () => {}, (e) => errB.push(e))
  created[0].emit('error', new Error('boom'))
  t.is(errB.length, 1, 'newest error callback received it')
  t.is(errA.length, 0, 'stale error callback did not')
  t.teardown(() => stopAllWatchers())
})

// After a stop, a fresh arm creates a new watcher and routes to its callback.
test('G3: a stopped key re-arms cleanly', async (t) => {
  created.length = 0
  const seen = []
  await startWatcher('s3', '/mnt/z', [], () => {}, () => {})
  stopWatcher('s3')
  await startWatcher('s3', '/mnt/z', [], (e) => seen.push(e), () => {})
  t.is(created.length, 2, 'a fresh watcher after stop')
  created[1].emit('add', '/mnt/z/g.txt')
  t.is(seen.length, 1, 'routed to the new callback')
  t.is(seen[0].action, 'add')
  t.teardown(() => stopAllWatchers())
})

// REGRESSION (FIX-462: the registry held ONE callback pair for every watcher, re-pointed by
// whichever start-watcher came last. Once a mirror's root was armed beside an owned share's, the
// last arm of either kind retargeted every watcher to its own frame builder, so an owned folder's
// edits arrived as mirror events or a mirror's as owned ones.)
test('REGRESSION (FIX-462): each key delivers to its own callback, and a re-arm of one leaves the other alone', async (t) => {
  created.length = 0
  const owned = []; const mirror = []; const ownedLater = []
  await startWatcher('s4', '/mnt/own', [], (e) => owned.push(e), () => {})
  await startWatcher('sp:s4', '/mnt/mirror', null, (e) => mirror.push(e), () => {})
  t.is(created.length, 2, 'one watcher per key')

  created[0].emit('change', '/mnt/own/a.txt')
  created[1].emit('unlink', '/mnt/mirror/b.txt')
  t.alike(owned, [{ action: 'change', relPath: 'a.txt', absPath: '/mnt/own/a.txt' }])
  t.alike(mirror, [{ action: 'unlink', relPath: 'b.txt', absPath: '/mnt/mirror/b.txt' }])

  await startWatcher('s4', '/mnt/own', [], (e) => ownedLater.push(e), () => {})
  created[1].emit('add', '/mnt/mirror/c.txt')
  t.is(mirror.length, 2, 'the mirror key still delivers to its own callback')
  t.is(ownedLater.length, 0)
  t.teardown(() => stopAllWatchers())
})

// A stop-watcher that never arrived (the worker died between a relocate's record write and its
// stop) leaves a live key at the old path; the respawned worker's start names the new one.
test('a re-arm at another path re-makes the root there', async (t) => {
  created.length = 0
  const seen = []
  await startWatcher('s6', '/mnt/old', [], () => {}, () => {})
  await startWatcher('s6', '/mnt/new', [], (e) => seen.push(e), () => {})
  t.is(created.length, 2, 'a fresh watcher for the new path')
  t.ok(created[0].closed, 'the old root is closed')
  t.alike(created[1].targets, ['/mnt/new'])
  created[1].emit('change', '/mnt/new/h.txt')
  t.alike(seen, [{ action: 'change', relPath: 'h.txt', absPath: '/mnt/new/h.txt' }])
  t.teardown(() => stopAllWatchers())
})

// Two starts for one key dispatched from one pipe chunk both pass the first guard; the second
// resumes to find the first's entry and must still own it.
test('a start that raced another past the import still retargets to its callback', async (t) => {
  created.length = 0
  const first = []; const second = []
  const a = startWatcher('s7', '/mnt/r', [], (e) => first.push(e), () => {})
  const b = startWatcher('s7', '/mnt/r', [], (e) => second.push(e), () => {})
  await Promise.all([a, b])
  t.is(created.length, 1, 'one watcher')
  created[0].emit('add', '/mnt/r/i.txt')
  t.is(second.length, 1, 'the newest caller received the event')
  t.is(first.length, 0)
  t.teardown(() => stopAllWatchers())
})

// A mirror names no patterns of its own; the defaults withhold the mirror's partials and the OS
// droppings, matched by the same data-layer function the owned side asks.
test('a null pattern list takes the data layer defaults', async (t) => {
  created.length = 0
  await startWatcher('sp:s5', '/mnt/m', null, () => {}, () => {})
  const ignored = created[0].opts.ignored
  t.ok(ignored('/mnt/m/report.txt.mirall.part', null), 'a partial is withheld')
  t.ok(ignored('/mnt/m/.DS_Store', null), 'so is an OS dropping')
  t.absent(ignored('/mnt/m/report.txt', null), 'a file is delivered')
  t.teardown(() => stopAllWatchers())
})

// Deterministic backstop: the adoption of a live entry must stay ahead of the await in startWatcher
// and be asked again after it, so a future refactor cannot reintroduce the stale per-worker binding.
test('G3 guard: startWatcher adopts a live entry before the await and again after it', (t) => {
  const src = readFileSync(SRC, 'utf8')
  const adopt = src.match(/function adopt[\s\S]*?\n\}/)?.[0] || ''
  const body = src.match(/async function startWatcher[\s\S]*?\n\}/)?.[0] || ''
  t.ok(adopt.includes('live.onEvent = onEvent'), 'adoption re-points the live entry')
  const awaitIdx = body.indexOf('await pathKeys')
  const adopts = [...body.matchAll(/if \(adopt\(/g)].map((m) => m.index)
  t.ok(awaitIdx > -1, 'the matcher import is awaited')
  t.is(adopts.length, 2, 'adoption is asked twice')
  t.ok(adopts[0] < awaitIdx && awaitIdx < adopts[1], 'once before the await and once after')
  t.ok(/entry\.onEvent\?\.\(/.test(body), 'the handler emits via the entry, not a module-level ref')
})

// chokidar's per-instance `ignored` option is this watcher's only ignore decision, and the
// periodic reconcile asks the data layer's matcher for the same answer. A matcher of its own
// here is how the two sides come to disagree about what a glob covers.
test('the ignore globs are matched by the data layer, not re-implemented here', (t) => {
  const src = readFileSync(SRC, 'utf8')
  t.ok(/folders\/path-keys\.js/.test(src), 'it reaches the shared matcher')
  t.ok(/shouldIgnore\(/.test(src), 'and asks it for the decision')
  t.absent(/\.endsWith\('\/\*\*'\)/.test(src), 'it re-implements no glob branch')
})
