import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { tmpDir, tmpPath } from '../helpers/bare-tmp.js'
import { until } from '../helpers/bare-poll.js'
import { scaled } from '../helpers/bare-timing.js'
import { trackTimers } from '../helpers/timers.js'
import { WATCH_MODE } from '../../src/shared/folders/watch-derive.js'
import { createWatchTree, WATCH_DEGRADED, WATCH_SETTLE_MS } from '../../src/shared/folders/watch-tree.js'
import { takeWatch, releaseWatch, resetWatchBudget, watchBudgetFacts } from '../../src/shared/folders/watch-budget.js'

// The settle window is a constructor option so no case pays a real second; the shipped default is
// asserted once, on its own, in M4b. The base value is scaled where it is handed to the module, so
// a slower runner widens the window and every `quiet(SETTLE * n)` beside it in the same proportion.
const SETTLE = 60
// A write made in the instant before a watcher is armed still reaches a recursive stream, so a case
// that pre-creates content lets it fall out of that window before it observes.
const PRE_ARM = 400
const quiet = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))
const saw = (events, action, rel) => events.some((e) => e.action === action && e.relPath === rel)
const forPath = (events, rel) => events.filter((e) => e.relPath === rel)

// A stream comes up asynchronously on darwin, so every case settles before its first mutation.
function observe(t, root, opts = {}) {
  const events = []
  const degraded = []
  const tree = createWatchTree({
    root,
    settleMs: scaled(SETTLE),
    onEvent: (e) => events.push(e),
    onDegraded: (d) => degraded.push(d),
    ...opts,
  })
  t.teardown(() => tree.close())
  tree.start()
  return { tree, events, degraded }
}

test('M1 — a root that is not there is reported, not armed', async (t) => {
  const missing = tmpPath('watch-tree-missing')
  const { tree, events, degraded } = observe(t, missing)
  await quiet(200)
  t.is(events.length, 0, 'a watch on a path that does not exist reports nothing')
  t.is(degraded[0]?.code, WATCH_DEGRADED.ROOT_MISSING, 'the root is reported as unwatchable')
  t.is(degraded[0]?.absPath, missing)
  t.is(tree.facts().directories, 0, 'and no handle is held')
})

test('M1b — a root that is a file is reported, not armed', async (t) => {
  const dir = tmpDir('watch-tree-file-root', t)
  const file = path.join(dir, 'root.txt')
  fs.writeFileSync(file, 'x')
  const { tree, events, degraded } = observe(t, file)
  await quiet(200)
  t.is(events.length, 0, 'a watch on a file reports nothing')
  t.is(degraded[0]?.code, WATCH_DEGRADED.NOT_A_DIRECTORY, 'and says why, rather than reading as a folder that is simply quiet')
  t.is(tree.facts().directories, 0, 'and no handle is held')
})

test('M2a — the budget refuses past the ceiling and gives handles back', (t) => {
  resetWatchBudget(watchBudgetFacts().reserve + 1)
  t.teardown(() => resetWatchBudget())
  t.ok(takeWatch(), 'the one handle under the ceiling is granted')
  t.absent(takeWatch(), 'the next is refused rather than armed into a dead handle')
  releaseWatch()
  t.ok(takeWatch(), 'a released handle is available again')
  releaseWatch()
})

test('M2b — a directory past the ceiling is reported instead of armed', async (t) => {
  const root = tmpDir('watch-tree-budget', t)
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  // The module's ceiling, not the kernel's: lowering fs.inotify.max_user_watches needs root and
  // would starve every other process on the box.
  resetWatchBudget(watchBudgetFacts().reserve + 2)
  t.teardown(() => resetWatchBudget())
  const { tree, degraded } = observe(t, root)
  await quiet(200)
  if (tree.facts().mode === WATCH_MODE.TREE) {
    t.is(tree.facts().directories, 2, 'two directories fit under the ceiling')
    t.is(degraded[0]?.code, WATCH_DEGRADED.BUDGET_EXHAUSTED, 'the third is reported, not pretended')
    t.is(degraded[0]?.absPath, path.join(root, 'a', 'b'))
  } else {
    t.is(tree.facts().directories, 1, 'a recursive watch holds one handle whatever the tree holds')
    t.is(degraded.length, 0, 'so no budget can be exhausted by its depth')
  }
})

test('M3 — a file written into a brand-new directory is reported', async (t) => {
  const root = tmpDir('watch-tree-nested', t)
  const { events } = observe(t, root)
  await quiet(200)
  const deep = path.join(root, 'a', 'b', 'c')
  fs.mkdirSync(deep, { recursive: true })
  fs.writeFileSync(path.join(deep, 'deep.txt'), 'x')
  t.ok(await until(() => saw(events, 'add', 'a/b/c/deep.txt'), 3000), 'the file has no watcher of its own; the arm-time scan is its event')
  await quiet(SETTLE * 5)
  const reports = forPath(events, 'a/b/c/deep.txt').length
  // Every level of the new chain raises its own event. At most one of them walks — the first, which
  // indexes the rest — so the file is reported by that walk and by its own settle, not once per
  // ancestor.
  t.ok(reports <= 2, `the chain is walked once, not once per level: ${reports}`)
})

test('M4a — a burst of writes to one file settles into a single event', async (t) => {
  const root = tmpDir('watch-tree-settle', t)
  const { events } = observe(t, root)
  await quiet(200)
  const file = path.join(root, 'big.bin')
  fs.writeFileSync(file, Buffer.alloc(4096))
  for (let i = 0; i < 200; i++) fs.appendFileSync(file, Buffer.alloc(4096))
  t.ok(await until(() => forPath(events, 'big.bin').length > 0, 3000), 'the file is reported')
  await quiet(SETTLE * 5)
  t.is(forPath(events, 'big.bin').length, 1, 'once, not once per write')
})

test('M4b — the default settle window is the one a long write needs', (t) => {
  t.is(WATCH_SETTLE_MS, 1000, 'one second, the window awaitWriteFinish held')
})

test('M5a — add, change and unlink are derived by stat', async (t) => {
  const root = tmpDir('watch-tree-derive', t)
  const { tree, events } = observe(t, root)
  await quiet(200)
  const file = path.join(root, 'a.txt')
  fs.writeFileSync(file, '1')
  t.ok(await until(() => saw(events, 'add', 'a.txt'), 3000), 'a created name is an add')
  await quiet(SETTLE * 4)
  fs.writeFileSync(file, '22')
  if (tree.facts().mode === WATCH_MODE.TREE) {
    t.ok(await until(() => saw(events, 'change', 'a.txt'), 3000), 'a modify is its own kind, so an edit of the same name is a change')
  } else {
    t.ok(await until(() => forPath(events, 'a.txt').length === 2, 3000), 'the edit is reported')
    t.is(forPath(events, 'a.txt')[1].action, 'add', 'a recursive stream names an edit a rename too, so it settles one word coarser — which every consumer, branching on unlink alone, cannot tell apart')
  }
  await quiet(SETTLE * 4)
  fs.rmSync(file)
  t.ok(await until(() => saw(events, 'unlink', 'a.txt'), 3000), 'a removal is an unlink')
})

test('M5b — a rename-over save reports the target once and never unlinks it', async (t) => {
  const root = tmpDir('watch-tree-atomic', t)
  const target = path.join(root, 'doc.txt')
  fs.writeFileSync(target, 'v1')
  await quiet(PRE_ARM)
  const { events } = observe(t, root)
  await quiet(200)
  const tmp = path.join(root, 'doc.txt.swp')
  fs.writeFileSync(tmp, 'v2')
  fs.renameSync(tmp, target)
  t.ok(await until(() => forPath(events, 'doc.txt').length > 0, 3000), 'the target is reported')
  await quiet(SETTLE * 5)
  t.is(forPath(events, 'doc.txt').length, 1, 'once — the rename lands on the target with no change behind it')
  t.absent(forPath(events, 'doc.txt').some((e) => e.action === 'unlink'), 'and never as an unlink: a loose entry would be tombstoned')
})

test('M5c — an event arriving while a window closes opens a fresh one', async (t) => {
  const root = tmpDir('watch-tree-race', t)
  const file = path.join(root, 'a.txt')
  fs.writeFileSync(file, '1')
  await quiet(PRE_ARM)
  const { events } = observe(t, root)
  await quiet(200)
  fs.writeFileSync(file, '22')
  t.ok(await until(() => forPath(events, 'a.txt').length === 1, 3000), 'the first window closes')
  fs.writeFileSync(file, '333')
  t.ok(await until(() => forPath(events, 'a.txt').length === 2, 3000), 'the second edit is not folded into a window already spent')
})

test('M6a — a renamed directory re-keys its subtree', async (t) => {
  const root = tmpDir('watch-tree-rename-dir', t)
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  const { tree, events } = observe(t, root)
  await quiet(200)
  const before = tree.facts().directories
  fs.renameSync(path.join(root, 'a'), path.join(root, 'z'))
  fs.writeFileSync(path.join(root, 'z', 'b', 'after.txt'), 'x')
  t.ok(await until(() => saw(events, 'add', 'z/b/after.txt'), 3000), 'the new path is watched')
  if (tree.facts().mode === WATCH_MODE.TREE) {
    t.is(tree.facts().directories, before, 'one subtree dropped, one armed — no handle leaked under the old name')
  } else {
    t.is(tree.facts().directories, 1, 'a recursive watch follows the rename with the one handle it has')
  }
})

test('M6b — a deleted directory takes its watchers with it', async (t) => {
  const root = tmpDir('watch-tree-drop', t)
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  const { tree } = observe(t, root)
  await quiet(200)
  const before = tree.facts().directories
  const charged = watchBudgetFacts().armed
  fs.rmSync(path.join(root, 'a'), { recursive: true })
  if (tree.facts().mode === WATCH_MODE.TREE) {
    t.ok(await until(() => tree.facts().directories === before - 2, 3000), 'the removed directory and its child are disarmed — the runtime leaves both open')
    t.is(watchBudgetFacts().armed, charged - 2, 'and their budget handles are back')
  } else {
    t.is(tree.facts().directories, 1, 'a recursive watch holds one handle whatever is removed beneath it')
  }
})

test('M6c — a deleted subtree reports the files that went with it and never a directory', async (t) => {
  const root = tmpDir('watch-tree-subtree', t)
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a', 'b', 'f.txt'), 'x')
  await quiet(PRE_ARM)
  const { events } = observe(t, root)
  await quiet(200)
  fs.rmSync(path.join(root, 'a'), { recursive: true })
  t.ok(await until(() => saw(events, 'unlink', 'a/b/f.txt'), 3000), 'the file under it is an unlink')
  await quiet(SETTLE * 5)
  // Every consumer reads a frame as a file — retire it, walk it, tombstone it — so a directory in
  // one is a path they act on as a file that never existed.
  const named = events.filter((e) => e.relPath === 'a' || e.relPath === 'a/b')
  t.is(named.length, 0, `no frame names a directory: ${JSON.stringify(named)}`)
})

test('M7 — a symlinked directory is not descended into', async (t) => {
  const root = tmpDir('watch-tree-symlink', t)
  const outside = tmpDir('watch-tree-outside', t)
  fs.mkdirSync(path.join(outside, 'inner'), { recursive: true })
  fs.symlinkSync(outside, path.join(root, 'link'))
  const { tree, events } = observe(t, root)
  await quiet(200)
  const armed = tree.facts().directories
  fs.writeFileSync(path.join(outside, 'inner', 'hidden.txt'), 'x')
  await quiet(SETTLE * 8)
  t.absent(events.some((e) => e.relPath.startsWith('link/')), 'nothing beyond the link is reported')
  t.is(tree.facts().directories, armed, 'and no handle was armed inside it')
})

test('M8 — a polled root reports add, change and unlink on its own interval', async (t) => {
  const root = tmpDir('watch-tree-poll', t)
  // test seam: production picks POLL from the path, and no writable path on this box looks like a
  // network mount, so the branch is pinned here. watchModeFor's own arms are covered in test/unit.
  const { events } = observe(t, root, { mode: WATCH_MODE.POLL, pollIntervalMs: 80 })
  await quiet(200)
  const file = path.join(root, 'a.txt')
  fs.writeFileSync(file, '1')
  t.ok(await until(() => saw(events, 'add', 'a.txt'), 3000), 'a created file is an add')
  fs.writeFileSync(file, '22')
  t.ok(await until(() => saw(events, 'change', 'a.txt'), 3000), 'a rewrite is a change')
  fs.rmSync(file)
  t.ok(await until(() => saw(events, 'unlink', 'a.txt'), 3000), 'a removal is an unlink')
})

// The one case that drives the watcher handles directly: a real watcher errors on nothing a test
// can cause, and the two states under test — a handle outliving its directory, and one erroring
// after close() — are reachable only by holding the handle and firing it.
test('M9 — a stale watcher error neither disarms the live one nor reports after close', (t) => {
  const root = tmpDir('watch-tree-stale', t)
  const sub = path.join(root, 'a')
  fs.mkdirSync(sub, { recursive: true })
  const made = []
  const realWatch = fs.watch
  fs.watch = (dir, opts, cb) => {
    const handlers = new Map()
    const fake = {
      dir,
      raw: cb,
      on: (kind, fn) => handlers.set(kind, fn),
      close: () => {},
      fail: (err) => handlers.get('error')?.(err),
    }
    made.push(fake)
    return fake
  }
  t.teardown(() => { fs.watch = realWatch })
  // test seam: the per-directory branch, so a second handle exists to be stale against.
  const { tree, degraded } = observe(t, root, { mode: WATCH_MODE.TREE })
  const stale = made.find((w) => w.dir === sub)
  t.ok(stale, 'the subdirectory is armed')
  fs.rmSync(sub, { recursive: true })
  made[0].raw('rename', 'a')
  t.is(tree.facts().directories, 1, 'the removed directory is disarmed')
  fs.mkdirSync(sub)
  made[0].raw('rename', 'a')
  t.is(tree.facts().directories, 2, 'and a directory of the same name is armed again')
  stale.fail(new Error('stale'))
  t.is(tree.facts().directories, 2, 'the old handle erroring leaves the live one armed')
  t.is(degraded.length, 0, 'and reports nothing: the directory is watched')
  tree.close()
  made[made.length - 1].fail(new Error('after close'))
  t.is(degraded.length, 0, 'a handle erroring after close tells a consumer that is already gone nothing')
})

test('closing the tree disarms every watcher and every settle timer', async (t) => {
  const tracker = trackTimers()
  t.teardown(() => tracker.restore())
  const root = tmpDir('watch-tree-close', t)
  fs.mkdirSync(path.join(root, 'a'), { recursive: true })
  const { tree } = observe(t, root)
  await quiet(200)
  fs.writeFileSync(path.join(root, 'a', 'x.txt'), 'x')
  // Polled fine enough to land inside the settle window itself, on either branch: the property
  // under test is that close() kills a timer that is armed, so an assertion that short-circuits on
  // one platform would leave it untested there.
  t.ok(await until(() => tree.facts().pending > 0, 3000, { interval: 5 }), 'a settle window is open')
  tree.close()
  t.is(tree.facts().directories, 0, 'no handle is left')
  t.is(tree.facts().pending, 0, 'no window is left')
  t.is(tracker.timeouts().length, 0, tracker.describe(tracker.timeouts()))
  t.is(tracker.intervals().length, 0, 'and no poll interval survives')
})
