import fs from 'bare-fs'
import path from 'bare-path'
import { listPending } from './pending-transfers.js'
import { PARTIAL_SUFFIX } from './partial-suffix.js'
import { hasResumeJournal } from './overlay/overlay-journals.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('partial-sweep')

// How long the boot sweep waits for one download root's listing. It runs before the topic joins, so
// a root on a network mount that stopped answering would hold boot until the mount timed out; a
// root skipped here costs only a reclaim deferred to the next boot.
const ROOT_READ_TIMEOUT_MS = 5000

const readdirOf = (dir) => fs.promises.readdir(dir)

// One root's listing, or a rejection once `timeoutMs` passed without one. The timer is the call's
// own and is cleared however the read ends.
async function readRoot(dir, readdir, timeoutMs) {
  let timer = null
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('no answer in ' + timeoutMs + ' ms')), timeoutMs)
  })
  try {
    return await Promise.race([readdir(dir), late])
  } finally {
    clearTimeout(timer)
  }
}

// Sweep orphaned partials. The overlay/loose engine leaves one at
// `<finalPath>${PARTIAL_SUFFIX}` while a transfer is in flight. A partial is orphaned
// when NO pending row and NO resume journal still reference it — a paused/resumable
// transfer keeps its journal (keyed by a digest of the target path, in a separate
// dir), so we never delete a partial it can still continue from. Runs once at boot
// over every download root (flat) and each foreign mount dir (recursive, since a mirror
// writes partials at the file's nested location, not in a download folder).
//
// Returns { rootsScanned, swept, failed } — the counts are what makes "every root was
// walked exactly once" and "one bad root did not abort the rest" observable to the caller
// and to tests; nothing branches on them. `readdir` and `readTimeoutMs` are test seams.
export async function cleanupOrphanedPartials(downloadsDirs, mountDirs = [], { readdir = readdirOf, readTimeoutMs = ROOT_READ_TIMEOUT_MS } = {}) {
  let swept = 0
  let failed = 0
  const referenced = new Set()
  for (const p of await listPending()) {
    if (p.finalPath) referenced.add(p.finalPath + PARTIAL_SUFFIX)
  }
  const isResumable = (full) => referenced.has(full) || hasResumeJournal(full.slice(0, -PARTIAL_SUFFIX.length))
  const sweepOne = async (full) => {
    if (isResumable(full)) return
    try {
      await fs.promises.unlink(full)
      swept += 1
      log.info('swept orphaned partial:', full)
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('partial sweep unlink failed:', full, err.message)
    }
  }

  // Download roots: a FLAT partial sits in a root, so a shallow read suffices; a TREE partial is
  // discarded with its row (discardRowPartials). The roots are read at once, each bounded by
  // ROOT_READ_TIMEOUT_MS. An unreadable one (ejected volume, EACCES after a permission change, a
  // path that is now a file, a mount that does not answer) is logged and skipped, NEVER rethrown —
  // a throw here would abandon both the remaining roots and the foreign-mount sweep below, and the
  // single caller only log.warns it, so crash-orphaned partials would leak on every boot.
  // A bare string would otherwise iterate as characters and silently sweep nothing.
  const roots = [...new Set(typeof downloadsDirs === 'string' ? [downloadsDirs] : (downloadsDirs || []))]
  const listings = await Promise.all(roots.map((dir) => readRoot(dir, readdir, readTimeoutMs).catch((err) => {
    if (err.code !== 'ENOENT') {
      failed += 1
      log.warn('partial sweep skipped unreadable download root:', dir, err.message)
    }
    return []
  })))
  for (const [i, dir] of roots.entries()) {
    for (const name of listings[i]) {
      if (name.endsWith(PARTIAL_SUFFIX)) await sweepOne(path.join(dir, name))
    }
  }

  // Foreign mount dirs: a mirror writes each file's partial at its nested location.
  for (const dir of mountDirs) {
    for (const full of await collectPartials(dir)) await sweepOne(full)
  }

  return { rootsScanned: roots.length, swept, failed }
}

// A deleted row's partial goes with it: the row is the only record of where the partial is, and the
// boot sweep reads only the folders the next boot can name — a TREE partial sits below them, and a
// folder only a left space downloaded into is not among them. The caller hands over the rows
// it just deleted. Two rows can name one destination (two spaces, or two owners of one name), so a
// partial that a remaining row or a `live` transfer still holds is kept.
// Accepted residual: a crash between the row delete and the unlink leaves one orphan partial.
/**
 * @param {{ finalPath?: string | null }[]} rows @param {{ live?: string[] }} [opts]
 * @returns {Promise<number>}
 */
export async function discardRowPartials(rows, { live = [] } = {}) {
  const held = new Set(live)
  for (const row of await listPending()) {
    if (typeof row.finalPath === 'string') held.add(row.finalPath)
  }
  let discarded = 0
  for (const row of rows) {
    if (typeof row.finalPath !== 'string' || held.has(row.finalPath)) continue
    try {
      await fs.promises.unlink(row.finalPath + PARTIAL_SUFFIX)
      discarded += 1
      log.info('discarded a forgotten row\'s partial:', row.finalPath)
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('partial discard failed:', row.finalPath, err.message)
    }
  }
  return discarded
}

// Best-effort recursive collect of partial files under `dir`. Metadata-only
// (readdir + stat), never throws — a mount that's gone/unreadable just yields nothing.
async function collectPartials(dir, out = []) {
  let names
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const full = path.join(dir, name)
    let st
    try {
      st = await fs.promises.stat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) await collectPartials(full, out)
    else if (name.endsWith(PARTIAL_SUFFIX)) out.push(full)
  }
  return out
}
