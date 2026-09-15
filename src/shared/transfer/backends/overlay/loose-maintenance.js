// Loose maintenance: the boot rehydrate and the presence sweep, both producers onto the shared
// publish lane. The serve maps and the reverse source map are not persisted, so every own loose
// file is re-registered after a restart; the sweep retires entries whose source vanished without
// a watcher unlink, on two consecutive misses.
import { listOwnShare } from '../../../shares/own-catalog.js'
import { getOwnedSourcePath } from '../../files.js'
import { listSpaces } from '../../../spaces/space.js'
import { getPublishScheduler } from '../../../folders/publish-service.js'
import { PRIORITY } from '../../../folders/work-item.js'
import { fileStatPresent, statFacts } from '../../../folders/disk-presence.js'
import { createPresenceSweeper } from '../../../folders/retire-confirm.js'
import { createLogger } from '../../../core/logger.js'
import { LOOSE_SHARE_ID } from '../../transfer-id.js'
import { adoptServable, enqueueLoosePublish, enqueueLooseRetire, revertUnhashedEntry } from './loose-publish.js'
import { looseDrivePath } from './loose-job.js'

const log = createLogger('loose-maintenance')

export function resetLooseMaintenance() { looseSweeper.reset() }

export async function rehydrateLooseFiles() {
  const pending = []
  for (const space of await listSpaces()) {
    try {
      for await (const e of listOwnShare(space.spaceId, LOOSE_SHARE_ID)) pending.push(rehydrateLooseEntry(space.spaceId, e))
    } catch (err) {
      log.debug('skip loose rehydrate for space', space.spaceId, '-', err.message)
    }
  }
  await Promise.allSettled(pending)
}

// Per-file isolation: one entry's failure must not abort the rest. A never-hashed entry with no
// recorded source is reverted; a finished entry that merely lost its source stays (it still
// displays as owned); a healthy, unchanged entry is re-registered with the serve gate directly;
// only an entry that needs the hash — null hash, or a source changed while offline — goes on
// the lane.
async function rehydrateLooseEntry(spaceId, e) {
  try {
    const src = await getOwnedSourcePath(spaceId, looseDrivePath(e.relPath))
    if (!src) {
      if (!e.contentHash) await revertUnhashedEntry(spaceId, e.relPath)
      return
    }
    if (e.contentHash && !fileStatPresent(src)) return
    const { size, mtime } = statFacts(src)
    if (e.contentHash && e.size === size && e.mtime === mtime) {
      await adoptServable(spaceId, e.relPath, src, e)
      return
    }
    await enqueueLoosePublish(spaceId, e.relPath, src, PRIORITY.BULK)
  } catch (err) {
    log.warn('skip loose file during rehydrate:', e.relPath, '-', err.message)
  }
}

// Proposes on two consecutive misses (an atomic-save window must not transiently unshare a
// still-present file) and the retire executor confirms the same way, on the shared lane. Never
// touches an entry whose publish is queued or running: disk presence decides only for settled
// entries. Each space's failures stay its own; one failing retire never skips the spaces after it.
const looseSweeper = createPresenceSweeper({
  keyOf: ({ spaceId }, e) => spaceId + '\0' + e.relPath,
  isPending: ({ spaceId }, e) => getPublishScheduler().isPending(spaceId, LOOSE_SHARE_ID, e.relPath),
  // No recorded source → a crash inside the tiny advertise→link window or a stranded entry from an
  // older install (reverted by the boot rehydrate, not the sweep). The sweep only reclaims a
  // RECORDED source that disappeared from disk.
  presentAt: async ({ spaceId }, e) => {
    const src = await getOwnedSourcePath(spaceId, looseDrivePath(e.relPath))
    return src ? fileStatPresent(src) : null
  },
  // Collected rather than awaited: the pass proposes every retire it finds and waits for them
  // together at the end.
  retire: ({ spaceId, retires }, e) => {
    retires.push(enqueueLooseRetire(spaceId, e.relPath, PRIORITY.BULK)
      .catch((err) => log.debug('loose retire failed:', e.relPath, '-', err.message)))
  },
})

export async function sweepLoosePresence() {
  const retires = []
  for (const space of await listSpaces()) {
    try {
      for await (const e of listOwnShare(space.spaceId, LOOSE_SHARE_ID)) {
        await looseSweeper.consider({ spaceId: space.spaceId, retires }, e)
      }
    } catch (err) {
      log.debug('skip loose presence sweep for space', space.spaceId, '-', err.message)
    }
  }
  await Promise.all(retires)
}
