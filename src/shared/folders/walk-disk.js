// Stat-only recursive walk of a mount root, producing '/'-separated relative keys
// ready for catalog comparison (Windows long-path prefixes stripped, ignores applied).
import fs from 'bare-fs'
import path from 'bare-path'
import { relToDriveKey, isAbsoluteDriveKey, shouldIgnore, shouldPruneDir, stripLongPathPrefix } from './path-keys.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('walk-disk')

// Every aborted walk raises this, not just a cancelled preview: the code is named for the first
// caller and kept because it is the on-the-wire value a catch already tests for. A caller that
// aborts a scan, a reconcile or a preview sees PREVIEW_CANCELLED and must treat it as "the walk
// stopped because I asked", never as a failure.
export class AbortError extends Error {
  constructor() {
    super('preview cancelled')
    this.code = 'PREVIEW_CANCELLED'
  }
}

// One readdir entry -> its '/'-separated key relative to the root, or null when the entry must be
// skipped: outside the root, unrepresentable, or ignored. Shared by the stat-ing walk and the
// stat-free count below, so "already at the destination" counts exactly the files the walk sees.
function entryKey(entry, root, cleanRoot, ignore) {
  const dir = entry.parentPath ?? entry.path ?? root
  const abs = path.join(dir, entry.name)
  const rel = relToDriveKey(path.relative(cleanRoot, stripLongPathPrefix(abs)), path.sep)
  if (!rel) return null
  if (rel === '..' || rel.startsWith('../') || isAbsoluteDriveKey(rel)) {
    log.warn('skipping file outside mount root:', abs, '→', rel)
    return null
  }
  if (shouldIgnore(rel, ignore)) return null
  return { abs, rel }
}

// How many files already sit at a destination — the count the mount preview reports. Stat-free on
// purpose: it answers "how many", not "how big", and walkDisk's per-file statSync is a blocking
// syscall on the worker's only thread, so paying it for a number nobody reads stalls the dialog the
// user is standing in front of. It also counts a file the walk would set aside as unreadable, which
// is still very much at the destination.
export async function countDiskFiles(root, ignore) {
  const cleanRoot = stripLongPathPrefix(root)
  const entries = await fs.promises.readdir(root, { recursive: true, withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    if (entry.isFile() && entryKey(entry, root, cleanRoot, ignore)) count += 1
  }
  return count
}

// Whether a directory's whole subtree is ignored, so the descent can be skipped. Conservative at
// every uncertainty: an unrepresentable or out-of-root directory is descended into, leaving the
// stat pass to warn about its files and discard them.
function dirIsPruned(abs, cleanRoot, ignore) {
  const rel = relToDriveKey(path.relative(cleanRoot, stripLongPathPrefix(abs)), path.sep)
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsoluteDriveKey(rel)) return false
  return shouldPruneDir(rel, ignore)
}

// One directory per await, BFS over an index (same order as a recursive readdir, without the O(n²)
// of shifting a queue). Every directory is a checkpoint: progress is reported and the abort signal
// is checked between directories, where a single recursive readdir is one un-interruptible syscall
// that reports nothing until the whole tree is read — a slow enumeration then reads as wedged and a
// recovery starts a second walk beside it. An unreadable directory PROPAGATES, as the recursive form
// does (measured: EACCES rejects, it does not skip): swallowing it would report every file beneath
// as absent, and the reconcile diff turns absent into tombstones.
//
// A directory whose whole subtree is ignored is not descended into; ignores are otherwise applied
// per FILE in the stat pass below, because only some glob shapes cover everything beneath the
// directory they name. The stat pass stays the authority on what publishes — pruning only avoids
// reading what that pass would discard.
async function enumerateFiles(root, cleanRoot, ignore, onProgress, signal) {
  const files = []
  const dirs = [root]
  for (let i = 0; i < dirs.length; i++) {
    if (signal?.aborted) throw new AbortError()
    const dir = dirs[i]
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!dirIsPruned(abs, cleanRoot, ignore)) dirs.push(abs)
      } else if (entry.isFile()) files.push({ name: entry.name, parentPath: dir })
    }
    onProgress?.({ phase: 'enumerating', scanned: 0, total: files.length, bytes: 0 })
  }
  return files
}

// Returns { onDisk: Map<relKey, { size, mtime }>, unreadable: Set<relKey> }.
// Stat-only — reads no file contents. `unreadable` holds paths that exist but
// couldn't be stat'd; they are skipped, never reported as absent — callers must
// not treat them as "absent" either, or the reconcile diff would see them as
// deleted and remove them from the share.
export async function walkDisk(root, ignore, { onProgress = null, signal = null } = {}) {
  const onDisk = new Map()
  const unreadable = new Set()
  // Under Bare on Windows, recursive readdir can return a `\\?\E:\…`-prefixed
  // parentPath while `root` has none; normalising both sides keeps path.relative
  // from emitting the absolute target verbatim as a key.
  const cleanRoot = stripLongPathPrefix(root)
  const files = await enumerateFiles(root, cleanRoot, ignore, onProgress, signal)
  const total = files.length
  let scanned = 0
  let bytes = 0
  onProgress?.({ phase: 'enumerating', scanned: 0, total, bytes: 0 })

  for (const entry of files) {
    if (signal?.aborted) throw new AbortError()
    const key = entryKey(entry, root, cleanRoot, ignore)
    if (!key) continue
    const { abs, rel } = key
    let stat
    try { stat = fs.statSync(abs) } catch { unreadable.add(rel); continue }
    const info = { size: stat.size, mtime: stat.mtimeMs }
    onDisk.set(rel, info)
    scanned += 1
    bytes += stat.size
    onProgress?.({ phase: 'scanning', scanned, total, bytes })
  }
  return { onDisk, unreadable }
}
