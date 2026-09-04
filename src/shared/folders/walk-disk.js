// Stat-only recursive walk of a mount root, producing '/'-separated relative keys
// ready for catalog comparison (Windows long-path prefixes stripped, ignores applied).
import fs from 'bare-fs'
import path from 'bare-path'
import { relToDriveKey, isAbsoluteDriveKey, shouldIgnore, stripLongPathPrefix } from './path-keys.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('walk-disk')

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
  const entries = await fs.promises.readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter((e) => e.isFile())
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
