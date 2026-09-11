import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { walkDisk } from '../../src/shared/folders/walk-disk.js'
import { DEFAULT_IGNORE, shouldIgnore } from '../../src/shared/folders/path-keys.js'

let seq = 0
function tmp() {
  const dir = path.join(os.tmpdir(), `mirall-walk-${Date.now()}-${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('stat-only walk returns size+mtime and never a hash', async (t) => {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'a.txt'), 'aaaa')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'bb')

  const { onDisk } = await walkDisk(root, [])
  t.is(onDisk.size, 2)
  const a = onDisk.get('a.txt')
  t.is(a.size, 4)
  t.ok(typeof a.mtime === 'number')
  t.absent(a.hash, 'the walk reads no file contents')
  t.ok(onDisk.has('sub/b.txt'), 'recurses, posix-joined keys')
})

test('ignore globs are honored', async (t) => {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'keep.txt'), 'k')
  fs.writeFileSync(path.join(root, '.DS_Store'), 'junk')
  const { onDisk } = await walkDisk(root, ['.DS_Store'])
  t.ok(onDisk.has('keep.txt'))
  t.absent(onDisk.has('.DS_Store'))
})

test('onProgress is monotonic and ends at the file count', async (t) => {
  const root = tmp()
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x'.repeat(i + 1))
  const seen = []
  const { onDisk } = await walkDisk(root, [], { onProgress: (p) => seen.push(p) })
  t.ok(seen.length >= 1)
  t.is(seen[seen.length - 1].scanned, onDisk.size)
  for (let i = 1; i < seen.length; i++) t.ok(seen[i].scanned >= seen[i - 1].scanned, 'scanned monotonic')
})

test('an aborted signal throws PREVIEW_CANCELLED', async (t) => {
  const root = tmp()
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x')
  try {
    await walkDisk(root, [], { signal: { aborted: true } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, 'PREVIEW_CANCELLED')
  }
})

// REGRESSION (FIX-WALK-ENUMERATE-BEAT: the enumeration was one `readdir(root, {recursive:true})`
// that returned nothing until the whole tree had been read. It reported no progress for its entire
// duration and the abort signal could not reach it, so the owner pass stamped nothing from
// started() until it finished — and a healthy slow enumeration on a network mount read as wedged.
// The supervisor's recovery then made it worse: abandoning the pass freed the key without stopping
// the walk, so the next reconcile enumerated the same mount a SECOND time, concurrently.)
test('REGRESSION (FIX-WALK-ENUMERATE-BEAT): the enumeration reports progress per directory', async (t) => {
  const root = tmp()
  for (const dir of ['one', 'two', 'two/deep']) fs.mkdirSync(path.join(root, ...dir.split('/')), { recursive: true })
  fs.writeFileSync(path.join(root, 'one', 'a.txt'), 'a')
  fs.writeFileSync(path.join(root, 'two', 'deep', 'b.txt'), 'b')

  const seen = []
  const { onDisk } = await walkDisk(root, [], { onProgress: (p) => seen.push(p) })
  const enumerating = seen.filter((p) => p.phase === 'enumerating')
  t.ok(enumerating.length >= 4, `one beat per directory, root included (found ${enumerating.length})`)
  t.is(onDisk.size, 2, 'and it still finds every file')
  t.ok(seen.every((p, i) => i === 0 || p.scanned >= seen[i - 1].scanned), 'scanned stays monotonic')
})

test('an abort taking effect between directories ends the enumeration', async (t) => {
  const root = tmp()
  for (let i = 0; i < 4; i++) {
    fs.mkdirSync(path.join(root, 'd' + i))
    fs.writeFileSync(path.join(root, 'd' + i, 'f.txt'), 'x')
  }
  const signal = { aborted: false }
  try {
    // Aborted from the progress hook, which is exactly where a pause or a supervisor recovery
    // reaches a pass that is still enumerating — a phase that used to be uninterruptible.
    await walkDisk(root, [], { signal, onProgress: () => { signal.aborted = true } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, 'PREVIEW_CANCELLED')
  }
})

// The enumeration must never turn an unreadable directory into "these files are gone": the
// reconcile diff reads absence as a delete and writes a tombstone per file. Measured against the
// recursive readdir this replaced — it rejects with EACCES rather than skipping the subtree.
test('an unreadable directory fails the walk rather than reporting its files absent', async (t) => {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'visible.txt'), 'v')
  const locked = path.join(root, 'locked')
  fs.mkdirSync(locked)
  fs.writeFileSync(path.join(locked, 'hidden.txt'), 'h')
  fs.chmodSync(locked, 0o000)
  t.teardown(() => { try { fs.chmodSync(locked, 0o755) } catch {} })

  let readable = true
  try { await fs.promises.readdir(locked, { withFileTypes: true }) } catch { readable = false }
  if (readable) {
    t.pass('running with rights that ignore the mode bits — nothing to assert')
    return
  }
  try {
    await walkDisk(root, [])
    t.fail('a subtree we cannot read must not resolve as a complete walk')
  } catch (err) {
    t.is(err.code, 'EACCES', 'it propagates, so the caller records a scan fault instead of deleting')
  }
})

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
}

// A skipped descent is proven by a directory the walk COULD NOT have read: were it still descending,
// the readdir would reject and take the whole walk with it, as it does for an unreadable directory
// that is not ignored.
test('an ignored directory tree is never read', async (t) => {
  const root = tmp()
  writeTree(root, { 'keep.txt': 'k', 'node_modules/pkg/index.js': 'x' })
  const nm = path.join(root, 'node_modules')
  fs.chmodSync(nm, 0o000)
  t.teardown(() => { try { fs.chmodSync(nm, 0o755) } catch {} })

  let readable = true
  try { await fs.promises.readdir(nm, { withFileTypes: true }) } catch { readable = false }
  if (readable) {
    t.pass('running with rights that ignore the mode bits — nothing to assert')
    return
  }
  const { onDisk } = await walkDisk(root, ['node_modules/**'])
  t.is(onDisk.size, 1)
  t.ok(onDisk.has('keep.txt'))
})

test('no readdir is issued at or beneath a pruned directory', async (t) => {
  const root = tmp()
  writeTree(root, {
    'src/a.js': 'a',
    'node_modules/pkg/deep/index.js': 'x',
    'node_modules/other/index.js': 'y',
    'src/node_modules/nested/index.js': 'z',
    '.git/objects/ab/cd': 'g',
  })
  const orig = fs.promises.readdir
  const seen = []
  fs.promises.readdir = (dir, opts) => { seen.push(dir); return orig(dir, opts) }
  t.teardown(() => { fs.promises.readdir = orig })

  const { onDisk } = await walkDisk(root, ['node_modules/**', '.git/**'])

  t.is(onDisk.size, 1, 'only the publishable file')
  t.ok(onDisk.has('src/a.js'))
  t.alike(seen.sort(), [root, path.join(root, 'src')].sort(), 'the root and the one live directory')
})

// Skipping a descent is a performance change: the published key set must stay exactly what the
// per-file matcher keeps from an un-ignored walk of the same tree.
test('pruning changes no key the ignore matcher would have kept', async (t) => {
  const root = tmp()
  writeTree(root, {
    'a.txt': '1',
    'src/index.js': '2',
    'src/build/out.js': '3',
    'rebuild/out.js': '4',
    'node_modules/pkg/index.js': '5',
    'src/node_modules/nested/x.js': '6',
    '.git/HEAD': '7',
    'docs/.git/HEAD': '8',
    'dist/app.js': '9',
    'logs/debug.log': '10',
    'cache~/held.txt': '11',
    'sub/notes.txt~': '12',
    'sub/.DS_Store': '13',
  })
  const patternSets = [
    [],
    DEFAULT_IGNORE,
    ['build/**'],
    ['**/node_modules'],
    ['**/build/**'],
    ['dist'],
    ['*~'],
    ['logs'],
    DEFAULT_IGNORE.concat(['build/**', 'dist', '*~']),
  ]
  const { onDisk: everything } = await walkDisk(root, [])
  const allKeys = [...everything.keys()].sort()

  for (const pats of patternSets) {
    const expected = allKeys.filter((k) => !shouldIgnore(k, pats))
    const { onDisk } = await walkDisk(root, pats)
    t.alike([...onDisk.keys()].sort(), expected, JSON.stringify(pats))
  }
})

// A bare name and a `*` glob name one path each: they withhold the directory ENTRY, which is never
// a file, so the walk must still descend and publish what is under it.
test('a pattern that is not directory-shaped still descends', async (t) => {
  const root = tmp()
  writeTree(root, { 'dist/app.js': 'a', 'cache~/held.txt': 'b', 'keep.txt': 'k' })
  const { onDisk } = await walkDisk(root, ['dist', '*~'])
  t.ok(onDisk.has('dist/app.js'), 'a bare name does not prune the tree')
  t.ok(onDisk.has('cache~/held.txt'), 'a suffix glob does not prune the tree')
  t.ok(onDisk.has('keep.txt'))
})

test('an abort still ends an enumeration that is mostly pruned', async (t) => {
  const root = tmp()
  writeTree(root, { 'node_modules/a/x.js': '1', 'one/f.txt': 'a', 'two/f.txt': 'b' })
  const signal = { aborted: false }
  try {
    await walkDisk(root, DEFAULT_IGNORE, { signal, onProgress: () => { signal.aborted = true } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, 'PREVIEW_CANCELLED')
  }
})
