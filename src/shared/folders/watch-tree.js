// One filesystem watcher over one root, reported in the vocabulary the publish, mirror and loose
// pipelines read: { action: 'add' | 'change' | 'unlink', relPath, absPath }, files only, the
// initial walk silent.
//
// The runtime gives 'rename' | 'change' and a name. There is no add/unlink split, no stats, no
// ignore predicate and no write-finish debounce, so each of those is derived here — see
// watch-derive.js for the two decisions and the header comments below for the rest.
//
// A recursive stream calls every file event a rename, so on that branch an in-place edit settles to
// `add` where the per-directory branch reports `change`. The publish, mirror and loose pipelines all
// branch on `unlink` alone, so the coarser word costs nothing and no per-path file index is kept to
// refine a distinction nothing reads.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { createLogger } from '../core/logger.js'
import { createTimers } from '../core/timers.js'
import { DEFAULT_IGNORE, relToDriveKey, shouldIgnore, shouldPruneDir } from './path-keys.js'
import { WATCH_MODE, settledAction, underPrefix, watchModeFor } from './watch-derive.js'
import { releaseWatch, takeWatch, watchBudgetFacts } from './watch-budget.js'

const log = createLogger('watch-tree')

// One 200 MB write arrives as tens of thousands of `change` events, so a path is reported once it
// has been quiet this long.
export const WATCH_SETTLE_MS = 1000
// A polled root is stat-walked whole on every tick, so the interval is the cost.
export const WATCH_POLL_INTERVAL_MS = 5000

// Why a directory is not being watched. Local to this module: nothing carries it across IPC, and a
// contract code with no thrower behind it counts against the unused-code ratchet.
export const WATCH_DEGRADED = Object.freeze({
  ROOT_MISSING: 'root-missing',
  NOT_A_DIRECTORY: 'not-a-directory',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  ARM_FAILED: 'arm-failed',
})

/** @typedef {(typeof WATCH_DEGRADED)[keyof typeof WATCH_DEGRADED]} WatchDegradedCode */
/** @import { WatchMode } from './watch-derive.js' */

/**
 * @typedef {object} WatchEvent
 * @property {'add' | 'change' | 'unlink'} action
 * @property {string} relPath  '/'-separated, relative to the root
 * @property {string} absPath
 *
 * @typedef {object} WatchDegradedReport
 * @property {WatchDegradedCode} code
 * @property {string} absPath
 * @property {WatchMode} mode
 * @property {number} armed
 * @property {number} limit
 * @property {number} reserve
 *
 * @typedef {object} WatchTreeFacts
 * @property {WatchMode} mode
 * @property {number} directories
 * @property {number} pending
 *
 * @typedef {object} WatchTree
 * @property {() => void} start
 * @property {() => void} close
 * @property {() => WatchTreeFacts} facts
 */

// One breadth-first pass: every directory that is not pruned, every file that is not ignored, with
// `armDir` arming each directory as it is reached and declining the ones it could not, and `onDir`
// told of each directory whether it armed or not. A symlink is a file whatever it points at, so a
// symlinked directory is reported and never descended into — its target is another tree, watched by
// whoever owns that path or by nobody. An explicit stack rather than recursion: the depth is the
// user's, not ours.
function collectTree(from, { root, ignore, armDir, onDir }) {
  const files = []
  const dirs = [from]
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]
    onDir?.(dir)
    if (armDir && !armDir(dir)) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      log.debug('readdir failed:', dir, '-', err.message)
      continue
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = relToDriveKey(path.relative(root, abs), path.sep)
      if (!entry.isSymbolicLink() && entry.isDirectory()) {
        if (!shouldPruneDir(rel, ignore)) dirs.push(abs)
        continue
      }
      if (!shouldIgnore(rel, ignore)) files.push({ abs, rel })
    }
  }
  return files
}

// Size and mtime together, because a same-size rewrite within one poll tick is a change a size
// comparison alone would miss. `lstatSync`, as everywhere else here: a symlink is stamped by its
// own target string, so a link whose target changes underneath it is not a change to this path, and
// a dangling one is still a path the diff can add and unlink.
function stampsOf(files) {
  const out = new Map()
  for (const file of files) {
    try {
      const st = fs.lstatSync(file.abs)
      out.set(file.rel, `${st.size}:${Math.round(st.mtimeMs ?? 0)}`)
    } catch (err) {
      log.debug('stat failed:', file.abs, '-', err.message)
    }
  }
  return out
}

// One quiet window per path, re-armed by every further event for that path, so a 200 MB write is
// reported once. The entry is deleted BEFORE `onSettled` runs, so an event arriving while a window
// resolves opens a fresh one instead of joining the one already closing.
function createSettleWindows(timers, settleMs, onSettled) {
  const pending = new Map()
  function settle(abs) {
    const entry = pending.get(abs)
    if (!entry) return
    pending.delete(abs)
    onSettled(abs, entry.sawRename)
  }
  return {
    size: () => pending.size,
    clear: () => pending.clear(),
    note(abs, kind) {
      const entry = pending.get(abs)
      if (entry) {
        timers.clear(entry.timer)
        entry.sawRename = entry.sawRename || kind === 'rename'
        entry.timer = timers.setTimeout(() => settle(abs), settleMs)
        return
      }
      pending.set(abs, { sawRename: kind === 'rename', timer: timers.setTimeout(() => settle(abs), settleMs) })
    },
  }
}

// A network mount emits no native events at all, so the only honest watch is one stat walk read
// against the last.
function emitStampDiff(before, next, report) {
  for (const [rel, stamp] of next) {
    const was = before.get(rel)
    if (was === undefined) report('add', rel)
    else if (was !== stamp) report('change', rel)
  }
  for (const rel of before.keys()) if (!next.has(rel)) report('unlink', rel)
}

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {string[]} [opts.ignore]
 * @param {number} [opts.settleMs]
 * @param {number} [opts.pollIntervalMs]
 * @param {WatchMode} [opts.mode] test seam: the branch a test drives on a path it can write to;
 *   production lets watchModeFor pick from the root
 * @param {(event: WatchEvent) => void} [opts.onEvent]
 * @param {(report: WatchDegradedReport) => void} [opts.onDegraded]
 * @returns {WatchTree}
 */
export function createWatchTree({
  root,
  ignore = DEFAULT_IGNORE,
  settleMs = WATCH_SETTLE_MS,
  pollIntervalMs = WATCH_POLL_INTERVAL_MS,
  mode = watchModeFor(root, os.platform()),
  onEvent,
  onDegraded,
}) {
  const timers = createTimers()
  const watchers = new Map()
  const stamps = new Map()
  // Every directory a walk has reached, in every native mode. The runtime says only that a name is
  // gone, so this is what tells a vanished directory from a vanished file — and an `unlink` frame
  // naming a directory is a word no consumer reads. It is also what says a directory event concerns
  // a subtree already indexed, so the arming walk runs once per new directory and not once per
  // ancestor of every deep create.
  const known = new Set()
  let started = false
  let closed = false

  const relOf = (abs) => relToDriveKey(path.relative(root, abs), path.sep)
  const absOf = (rel) => path.join(root, ...rel.split('/'))
  const emit = (action, rel, abs) => onEvent?.({ action, relPath: rel, absPath: abs })
  const armDir = (dir) => arm(dir, false)
  const collect = (from, arming) => collectTree(from, { root, ignore, armDir: arming, onDir: (dir) => known.add(dir) })
  // The polled branch reads no index: every tick compares whole stamp maps, so remembering
  // directories there would only be a set that grows for the life of the tree.
  const scan = () => collectTree(root, { root, ignore, armDir: null, onDir: null })
  // lstatSync, not the promise form: with no await between the window's delete and the emit there
  // is no interleaving point at all, and an lstat never follows a link.
  const windows = createSettleWindows(timers, settleMs, (abs, sawRename) => {
    let st = null
    try { st = fs.lstatSync(abs) } catch { st = null }
    const action = settledAction({ exists: !!st && !st.isDirectory(), sawRename })
    if (action) emit(action, relOf(abs), abs)
  })

  function degraded(code, absPath) {
    onDegraded?.({ code, absPath, mode, ...watchBudgetFacts() })
  }

  // fs.watch on a path that is not there returns a watcher that never fires and never errors, so a
  // failed arm and a quiet one are the same thing to the caller. Stat first, and report.
  function arm(dir, recursive) {
    if (watchers.has(dir)) return true
    let st = null
    try { st = fs.statSync(dir) } catch { st = null }
    if (!st) {
      // Only the root is missing as a ROOT. A subdirectory that went while the walk reached it is
      // an arm that did not happen, and reporting it under the root's word would name the wrong path.
      degraded(dir === root ? WATCH_DEGRADED.ROOT_MISSING : WATCH_DEGRADED.ARM_FAILED, dir)
      return false
    }
    if (!st.isDirectory()) {
      degraded(WATCH_DEGRADED.NOT_A_DIRECTORY, dir)
      return false
    }
    if (!takeWatch()) {
      degraded(WATCH_DEGRADED.BUDGET_EXHAUSTED, dir)
      return false
    }
    let watcher
    try {
      watcher = fs.watch(dir, { recursive }, (kind, name) => onRaw(dir, kind, name))
    } catch (err) {
      releaseWatch()
      log.warn('watch arm failed:', dir, '-', err.message)
      degraded(WATCH_DEGRADED.ARM_FAILED, dir)
      return false
    }
    // A dropped subtree's watcher can error after a directory of the same name has been armed
    // again, and a closed tree has no consumer left to tell. Only the handle this map still holds
    // is the one to disarm, and only an open tree reports.
    watcher.on('error', (err) => {
      if (closed || watchers.get(dir) !== watcher) return
      log.warn('watcher error:', dir, '-', err.message)
      disarm(dir)
      degraded(WATCH_DEGRADED.ARM_FAILED, dir)
    })
    watchers.set(dir, watcher)
    return true
  }

  // A removed directory's watcher stays open and does not error, so closing it here is what returns
  // its handle to the budget — on linux the kernel watch is already gone and the handle is dead.
  function disarm(dir) {
    const watcher = watchers.get(dir)
    if (!watcher) return
    watchers.delete(dir)
    releaseWatch()
    try { watcher.close() } catch (err) { log.debug('watcher close failed:', dir, '-', err.message) }
  }

  function dropSubtree(prefix) {
    for (const dir of [...watchers.keys()]) {
      if (dir === prefix || underPrefix(dir, prefix, path.sep)) disarm(dir)
    }
    for (const dir of known) {
      if (dir === prefix || underPrefix(dir, prefix, path.sep)) known.delete(dir)
    }
  }

  // The recursive mode reports a path from the root and the per-directory mode a bare name, so one
  // join covers both.
  function onRaw(dir, kind, name) {
    if (closed) return
    const abs = name ? path.join(dir, name) : dir
    if (abs === root) return
    const rel = relOf(abs)
    if (!rel || rel === '..' || rel.startsWith('../')) return
    let st = null
    try { st = fs.lstatSync(abs) } catch { st = null }
    if (st && !st.isSymbolicLink() && st.isDirectory()) {
      if (shouldPruneDir(rel, ignore)) return
      // An indexed directory is already covered: every level of a nested create raises an event of
      // its own, and a file added under a directory the index holds is reported by the stream or by
      // that directory's own handle. Walking it again would re-report its whole subtree once per
      // ancestor, so only a name the index has not seen is walked.
      if (known.has(abs)) return
      // Dropped before it is armed, so a name re-used by a different directory never keeps the
      // departed subtree's handles indexed under it.
      dropSubtree(abs)
      // A file written in the instant its parent was created had no watcher to see it, and a
      // directory moved in as a unit raises no event for the files inside it, so the arming walk
      // reports what it finds: this is the event those files never got.
      for (const file of collect(abs, mode === WATCH_MODE.TREE ? armDir : null)) emit('add', file.rel, file.abs)
      return
    }
    if (!st && known.has(abs)) {
      // A directory that was removed or moved out: its handles go and no frame does. Every consumer
      // reads these frames as files, so a directory named in one is a path they would retire or
      // walk as if it were one. The files that went with it are the catch-up reconcile's to notice —
      // this module keeps no file index to derive their unlinks from.
      dropSubtree(abs)
      return
    }
    if (shouldIgnore(rel, ignore)) return
    windows.note(abs, kind)
  }

  function poll() {
    if (closed) return
    const next = stampsOf(scan())
    emitStampDiff(stamps, next, (action, rel) => emit(action, rel, absOf(rel)))
    stamps.clear()
    for (const [rel, stamp] of next) stamps.set(rel, stamp)
  }

  function start() {
    if (started || closed) return
    started = true
    let st = null
    try { st = fs.statSync(root) } catch { st = null }
    if (!st) {
      degraded(WATCH_DEGRADED.ROOT_MISSING, root)
      return
    }
    // A root that is a file arms a watcher that fires on nothing and walks nothing, which is the
    // one state this module exists to make impossible: a caller cannot tell it from a quiet folder.
    if (!st.isDirectory()) {
      degraded(WATCH_DEGRADED.NOT_A_DIRECTORY, root)
      return
    }
    if (mode === WATCH_MODE.POLL) {
      for (const [rel, stamp] of stampsOf(scan())) stamps.set(rel, stamp)
      timers.setInterval(poll, pollIntervalMs)
      return
    }
    if (mode === WATCH_MODE.RECURSIVE) {
      // One handle covers the tree; the directory index does not come with it. The walk is silent
      // and is what later lets a path that vanishes be told from a file that did.
      if (arm(root, true)) collect(root, null)
      return
    }
    // One handle per directory, and silent: a folder's existing contents are the reconcile's
    // business, not the watcher's.
    collect(root, armDir)
  }

  function close() {
    if (closed) return
    closed = true
    for (const dir of [...watchers.keys()]) disarm(dir)
    windows.clear()
    stamps.clear()
    known.clear()
    timers.close()
  }

  function facts() {
    return { mode, directories: watchers.size, pending: windows.size() }
  }

  return { start, close, facts }
}
