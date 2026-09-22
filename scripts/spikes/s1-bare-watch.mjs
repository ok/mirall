// Spike S1 — what bare-fs.watch delivers on this platform. Runs under bare, not shipped.
//
//   bare scripts/spikes/s1-bare-watch.mjs <root> [--mode native|tree]
//
// Prints one NDJSON line per observed event with the wall-clock ms it arrived; the driver
// (s1-drive.mjs) mutates the tree with the same clock and pairs the two logs.
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { flag, line, errorCode } from './lib.mjs'

const [root, ...rest] = Bare.argv.slice(2)
const mode = flag(rest, '--mode', 'native')

// Case A — the one-liner. libuv honours `recursive` on macOS and Windows; on Linux it is
// expected to watch the root only, and the spike's first number is how much that misses.
function watchNative(dir) {
  const w = fs.watch(dir, { recursive: true }, (eventType, filename) => {
    line({ mode: 'native', eventType, path: filename ? path.join(dir, filename) : dir })
  })
  w.on('error', (err) => line({ mode: 'native', dir, error: errorCode(err) }))
  return w
}

// Case B — one watcher per directory, the shape chokidar itself takes on Linux. A new
// directory is armed from its parent's 'rename'; a removed directory's watcher is dropped.
const tree = new Map()
const exists = (p) => { try { fs.lstatSync(p); return true } catch { return false } }
function watchTree(dir) {
  if (tree.has(dir)) return
  let w
  try {
    w = fs.watch(dir, { recursive: false }, (eventType, filename) => {
      // A directory's own removal arrives under its basename, not as a child.
      const self = filename === path.basename(dir) && !exists(dir)
      const full = self ? dir : (filename ? path.join(dir, filename) : dir)
      line({ mode: 'tree', eventType, path: full, self: self || undefined })
      if (eventType !== 'rename') return
      let st = null
      try { st = fs.lstatSync(full) } catch {}
      if (st?.isDirectory()) walk(full, true)
      else if (!st) dropSubtree(full)
    })
  } catch (err) {
    line({ mode: 'tree', dir, error: errorCode(err) })
    return
  }
  w.on('error', (err) => { line({ mode: 'tree', dir, error: errorCode(err) }); tree.delete(dir) })
  w.on('close', () => { line({ mode: 'tree', dir, closed: true }); tree.delete(dir) })
  tree.set(dir, w)
}
// A directory armed from a 'rename' is scanned once: a file written between its creation and
// the arm has no watcher to report it, so the scan stands in for that event. The initial walk
// stays silent, the way chokidar's ignoreInitial does.
function walk(dir, announce = false) {
  watchTree(dir)
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory() && !ent.isSymbolicLink()) walk(full, announce)
    else if (announce && ent.isFile()) line({ mode: 'tree', eventType: 'scan', path: full })
  }
}
function dropSubtree(prefix) {
  for (const [dir, w] of tree) {
    if (dir === prefix || dir.startsWith(prefix + path.sep)) { w.close(); tree.delete(dir) }
  }
}

if (mode === 'native') watchNative(root)
else walk(root)

line({ ready: true, mode, pid: Bare.pid, watched: mode === 'tree' ? tree.size : 1, platform: os.platform(), arch: os.arch(), bare: Bare.version })

// The watcher-count line lets the driver see leaks after a subtree delete. SIGTERM ends the run.
let lastWatched = -1
setInterval(() => {
  if (tree.size === lastWatched) return
  lastWatched = tree.size
  line({ watched: tree.size })
}, 250)
