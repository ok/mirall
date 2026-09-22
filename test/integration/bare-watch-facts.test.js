import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { tmpDir } from '../helpers/bare-tmp.js'
import { until } from '../helpers/bare-poll.js'
import { scaled } from '../helpers/bare-timing.js'

// Pins what bare-fs.watch delivers on this platform. The daemon's directory watcher is designed
// against these answers, so a bare-fs or bare-runtime bump that changes one turns red here rather
// than surfacing as a folder that quietly stops re-publishing.

const platform = os.platform()
const settle = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

// A stream on darwin comes up asynchronously, so every test settles before its first mutation.
function observe(t, dir, opts) {
  const seen = []
  const lifecycle = { closed: false, error: null }
  const w = fs.watch(dir, opts, (type, name) => seen.push({ type, name }))
  w.on('close', () => { lifecycle.closed = true })
  w.on('error', (err) => { lifecycle.error = err })
  t.teardown(() => w.close())
  return { seen, lifecycle, w }
}

const sawName = (seen, name) => seen.some((e) => e.name === name)

test('a non-recursive watch reports a direct child create as rename', async (t) => {
  const root = tmpDir('watch-facts', t)
  const { seen } = observe(t, root)
  await settle(100)
  fs.writeFileSync(path.join(root, 'a.txt'), 'x')
  t.ok(await until(() => sawName(seen, 'a.txt'), 2000), 'child create observed')
  t.is(seen.find((e) => e.name === 'a.txt').type, 'rename', 'a create is a rename, not a change')
})

test('recursive: true on linux does not see a nested create', { skip: platform !== 'linux' }, async (t) => {
  const root = tmpDir('watch-facts', t)
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  const { seen } = observe(t, root, { recursive: true })
  await settle(100)
  fs.writeFileSync(path.join(root, 'a', 'b', 'deep.txt'), 'x')
  const saw = await until(() => seen.some((e) => String(e.name).includes('deep.txt')), 1000)
  // inotify watches one directory; libuv ignores the recursive flag there. A pass here means the
  // runtime grew recursive inotify and the per-directory tree is no longer the only option.
  t.absent(saw, 'nested create is not delivered by a recursive watch on linux')
})

test('recursive: true on darwin reports a nested create by its relative path', { skip: platform !== 'darwin' }, async (t) => {
  const root = tmpDir('watch-facts', t)
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  const { seen } = observe(t, root, { recursive: true })
  await settle(100)
  fs.writeFileSync(path.join(root, 'a', 'b', 'deep.txt'), 'x')
  const rel = path.join('a', 'b', 'deep.txt')
  t.ok(await until(() => sawName(seen, rel), 2000), 'nested create observed with its path from the root')
})

test('a watch on a path that does not exist neither throws nor errors', async (t) => {
  const root = tmpDir('watch-facts', t)
  // The binding does not check the start result, so a failed arm looks exactly like a quiet one.
  // A host that wants to know must stat the path before it arms.
  const { seen, lifecycle } = observe(t, path.join(root, 'missing'))
  await settle(300)
  t.is(lifecycle.error, null, 'no error event')
  t.absent(lifecycle.closed, 'not closed')
  t.is(seen.length, 0, 'no events')
})

test('a watcher on a removed directory stays open and reports the removal on its own name', async (t) => {
  const root = tmpDir('watch-facts', t)
  const sub = path.join(root, 'gone')
  fs.mkdirSync(sub)
  const { seen, lifecycle } = observe(t, sub)
  await settle(100)
  fs.rmSync(sub, { recursive: true })
  t.ok(await until(() => sawName(seen, 'gone'), 2000), 'the removal is reported under the directory name')
  t.absent(lifecycle.closed, 'the watcher does not close itself')
  t.is(lifecycle.error, null, 'and does not error')
})

test('a file rename is reported as rename on both names, never as change', async (t) => {
  const root = tmpDir('watch-facts', t)
  fs.writeFileSync(path.join(root, 'a'), '1')
  const { seen } = observe(t, root)
  await settle(100)
  fs.renameSync(path.join(root, 'a'), path.join(root, 'b'))
  t.ok(await until(() => sawName(seen, 'a') && sawName(seen, 'b'), 2000), 'both names reported')
  const kinds = new Set(seen.filter((e) => e.name === 'a' || e.name === 'b').map((e) => e.type))
  // There is no add/unlink vocabulary: which side of a rename a name is on comes from a stat.
  t.alike([...kinds], ['rename'])
})
