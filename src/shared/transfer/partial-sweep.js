import fs from 'bare-fs'
import path from 'bare-path'
import { listPending } from './pending-transfers.js'
import { journalNameFor } from './backends/overlay/vendor/transfer.js'
import { PARTIAL_SUFFIX } from './partial-suffix.js'
import { getJournalDir } from './backends/overlay/overlay-instance.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('partial-sweep')

// Sweep orphaned partials. The overlay/loose engine leaves one at
// `<finalPath>${PARTIAL_SUFFIX}` while a transfer is in flight. A partial is orphaned
// when NO pending row and NO resume journal still reference it — a paused/resumable
// transfer keeps its journal (keyed by a digest of the target path, in a separate
// dir), so we never delete a partial it can still continue from. Runs once at boot
// over the Downloads dir (flat) and each foreign mount dir (recursive, since a mirror
// writes partials at the file's nested location, not in Downloads).
export async function cleanupOrphanedPartials (downloadsDir, mountDirs = []) {
  const referenced = new Set()
  for (const p of await listPending()) {
    if (p.finalPath) referenced.add(p.finalPath + PARTIAL_SUFFIX)
  }
  let journalDir = null
  try { journalDir = getJournalDir() } catch {}

  const isResumable = (full) => {
    if (referenced.has(full)) return true
    if (!journalDir) return false
    const target = full.slice(0, -PARTIAL_SUFFIX.length)
    try { return fs.existsSync(path.join(journalDir, journalNameFor(target))) } catch { return false }
  }
  const sweepOne = async (full) => {
    if (isResumable(full)) return
    try {
      await fs.promises.unlink(full)
      log.info('swept orphaned partial:', full)
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('partial sweep unlink failed:', full, err.message)
    }
  }

  // Downloads dir: partials land flat (basename), so a shallow read suffices.
  let names
  try {
    names = await fs.promises.readdir(downloadsDir)
  } catch (err) {
    if (err.code === 'ENOENT') names = []
    else throw err
  }
  for (const name of names) {
    if (name.endsWith(PARTIAL_SUFFIX)) await sweepOne(path.join(downloadsDir, name))
  }

  // Foreign mount dirs: a mirror writes each file's partial at its nested location.
  for (const dir of mountDirs) {
    for (const full of await collectPartials(dir)) await sweepOne(full)
  }
}

// Best-effort recursive collect of partial files under `dir`. Metadata-only
// (readdir + stat), never throws — a mount that's gone/unreadable just yields nothing.
async function collectPartials (dir, out = []) {
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
