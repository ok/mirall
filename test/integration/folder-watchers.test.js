import test from 'brittle'
import { readFileSync } from 'bare-fs'
import path from 'bare-path'
import { fakeWatchEnv } from '../helpers/fake-watcher.js'
import { createFolderWatchers } from '../../src/worker/watchers/folder-watchers.js'

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src', 'worker', 'watchers', 'folder-watchers.js')

// The watcher package is the fake (see the helper), so event routing is driven synchronously:
// real fsevents timing plus awaitWriteFinish makes an fs-watch test slow and flaky.
function folders() {
  const fake = fakeWatchEnv({ platform: 'darwin' })
  return { folders: createFolderWatchers(fake.env), created: fake.created }
}

// REGRESSION (FIX-462: the registry held ONE callback pair for every watcher, re-pointed by
// whichever start-watcher came last. Once a mirror's root was armed beside an owned share's, the
// last arm of either kind retargeted every watcher to its own frame builder, so an owned folder's
// edits arrived as mirror events or a mirror's as owned ones.)
test('REGRESSION (FIX-462): each key delivers to its own callback', (t) => {
  const { folders: f, created } = folders()
  const owned = []; const mirror = []
  f.start('s4', '/data/own', [], (e) => owned.push(e), () => {})
  f.start('sp:s4', '/data/mirror', null, (e) => mirror.push(e), () => {})
  t.is(created.length, 2, 'one watcher per key')

  created[0].emit('change', '/data/own/a.txt')
  created[1].emit('unlink', '/data/mirror/b.txt')
  t.alike(owned, [{ action: 'change', relPath: 'a.txt', absPath: '/data/own/a.txt' }])
  t.alike(mirror, [{ action: 'unlink', relPath: 'b.txt', absPath: '/data/mirror/b.txt' }])
  t.teardown(() => f.stopAll())
})

test('a nested file arrives with a forward-slash relative path', (t) => {
  const { folders: f, created } = folders()
  const seen = []
  f.start('s1', '/data/own', [], (e) => seen.push(e), () => {})
  created[0].emit('add', '/data/own/sub/deeper/c.txt')
  t.alike(seen, [{ action: 'add', relPath: 'sub/deeper/c.txt', absPath: '/data/own/sub/deeper/c.txt' }])
  t.teardown(() => f.stopAll())
})

test('a second start for a live key at the same path keeps the one watcher', (t) => {
  const { folders: f, created } = folders()
  const seen = []
  f.start('s1', '/data/x', [], (e) => seen.push(e), () => {})
  f.start('s1', '/data/x', [], () => {}, () => {})
  t.is(created.length, 1, 'no second watcher')
  created[0].emit('change', '/data/x/f.txt')
  t.is(seen.length, 1, 'the watcher still delivers')
  t.teardown(() => f.stopAll())
})

// A relocate stops and re-arms; a start that names a new path for a live key re-makes the root
// there rather than leaving it on the old one.
test('a start at another path re-makes the root there', (t) => {
  const { folders: f, created } = folders()
  const seen = []
  f.start('s6', '/data/old', [], () => {}, () => {})
  f.start('s6', '/data/new', [], (e) => seen.push(e), () => {})
  t.is(created.length, 2, 'a fresh watcher for the new path')
  t.ok(created[0].closed, 'the old root is closed')
  t.alike(created[1].targets, ['/data/new'])
  t.is(f.watchedPath('s6'), '/data/new')
  created[1].emit('change', '/data/new/h.txt')
  t.alike(seen, [{ action: 'change', relPath: 'h.txt', absPath: '/data/new/h.txt' }])
  t.teardown(() => f.stopAll())
})

test('a stopped key re-arms cleanly', (t) => {
  const { folders: f, created } = folders()
  const seen = []
  f.start('s3', '/data/z', [], () => {}, () => {})
  f.stop('s3')
  t.is(f.watchedPath('s3'), null, 'nothing watched after the stop')
  f.start('s3', '/data/z', [], (e) => seen.push(e), () => {})
  t.is(created.length, 2, 'a fresh watcher after stop')
  created[1].emit('add', '/data/z/g.txt')
  t.is(seen.length, 1)
  t.is(seen[0].action, 'add')
  t.teardown(() => f.stopAll())
})

test('a stormed root forgets its key, so the next start builds a fresh one', (t) => {
  const { folders: f, created } = folders()
  const errors = []
  f.start('s8', '/data/s', [], () => {}, (e) => errors.push(e))
  for (let i = 0; i < 6; i++) created[0].emit('error', new Error('boom'))
  t.ok(created[0].closed, 'the stormed watcher closed')
  t.is(f.watchedPath('s8'), null, 'and its key is gone')
  t.ok(errors.some((e) => /error-storm: watcher stopped for s8/.test(e.message)), 'the storm is reported under the key')
  f.start('s8', '/data/s', [], () => {}, () => {})
  t.is(created.length, 2)
  t.teardown(() => f.stopAll())
})

test('stopAll closes every root', (t) => {
  const { folders: f, created } = folders()
  f.start('a', '/data/a', [], () => {}, () => {})
  f.start('b', '/data/b', [], () => {}, () => {})
  f.stopAll()
  t.ok(created.every((w) => w.closed))
  t.is(f.watchedPath('a'), null)
})

// A mirror names no patterns of its own; the defaults withhold the mirror's partials and the OS
// droppings, matched by the same data-layer function the owned side asks.
test('a null pattern list takes the data layer defaults', (t) => {
  const { folders: f, created } = folders()
  f.start('sp:s5', '/data/m', null, () => {}, () => {})
  const ignored = created[0].opts.ignored
  t.ok(ignored('/data/m/report.txt.mirall.part', null), 'a partial is withheld')
  t.ok(ignored('/data/m/.DS_Store', null), 'so is an OS dropping')
  t.absent(ignored('/data/m/report.txt', null), 'a file is delivered')
  t.absent(ignored('/data/m', null), 'the root itself is never ignored')
  t.teardown(() => f.stopAll())
})

test('an owned share\'s globs are asked of a directory as a directory', (t) => {
  const { folders: f, created } = folders()
  f.start('s9', '/data/o', ['build/'], () => {}, () => {})
  const ignored = created[0].opts.ignored
  const dir = { isDirectory: () => true }
  t.ok(ignored('/data/o/build', dir), 'a directory glob prunes the directory')
  t.absent(ignored('/data/o/src/a.js', { isDirectory: () => false }), 'and leaves the rest')
  t.teardown(() => f.stopAll())
})

// The per-instance `ignored` option is this watcher's only ignore decision, and the
// periodic reconcile asks the data layer's matcher for the same answer. A matcher of its own
// here is how the two sides come to disagree about what a glob covers.
test('the ignore globs are matched by the data layer, not re-implemented here', (t) => {
  const src = readFileSync(SRC, 'utf8')
  t.ok(/folders\/path-keys\.js/.test(src), 'it reaches the shared matcher')
  t.ok(/shouldIgnore\(/.test(src), 'and asks it for the decision')
  t.absent(/\.endsWith\('\/\*\*'\)/.test(src), 'it re-implements no glob branch')
})
