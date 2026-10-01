// Storage accounting behind the Storage screen: the store's disk footprint, attributed per space
// (own and member catalogs), to the shared-file index, the Activity Log and the download history,
// with the unattributed rest as "other". Plus the boot-time metadata sweep.
import fs from 'bare-fs'
import path from 'bare-path'
import { createLogger } from '../core/logger.js'
import { getStoragePath, getStore, localBeeDiscoveryKeys } from '../core/store.js'
import { listSpaces } from '../spaces/space.js'
import { purgeLeftovers } from './leftover.js'
import { measureCoreBytes } from './core-bytes.js'
import { spaceCatalogCores } from './space-catalog-cores.js'
import { storageBreakdown } from './storage-breakdown.js'

const log = createLogger('storage')

function getDirSize(dirPath) {
  let size = 0
  try {
    const entries = fs.readdirSync(dirPath)
    for (const entry of entries) {
      const full = path.join(dirPath, entry)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        size += getDirSize(full)
      } else {
        size += stat.size
      }
    }
  } catch (err) {
    log.warn('cannot stat:', dirPath, err.message)
  }
  return size
}

const ACTIVITY_LOG_BEES = ['audit-log']
const DOWNLOAD_HISTORY_BEES = ['downloads-meta', 'pending-transfers']

// A part that cannot be measured reports its fallback, and whatever it held falls to "other",
// rather than blanking the whole screen.
async function measured(label, fallback, fn) {
  try {
    return await fn()
  } catch (err) {
    log.warn('storage:', label, 'unmeasured -', err.message)
    return fallback
  }
}

async function localBeeDks(names) {
  return (await Promise.all(names.map(localBeeDiscoveryKeys))).flat()
}

async function spaceCores(space) {
  const none = { own: [], members: [] }
  const cores = await measured('space ' + space.spaceId, none, () => spaceCatalogCores(space))
  return { spaceId: space.spaceId, name: space.name || '', ...cores }
}

// The index's chunk maps are values large enough for the store to keep in blob files, outside any
// range estimate, so the index is measured by its cores' logical length.
async function overlayIndexBytes() {
  const { getOverlayLocalByteLength } = await import('../transfer/overlay/overlay-instance.js')
  return getOverlayLocalByteLength()
}

export async function getStorageInfo() {
  const totalDiskUsage = getDirSize(getStoragePath())
  const [spaces, indexBytes, activityLog, downloadHistory] = await Promise.all([
    measured('spaces', [], async () => Promise.all((await listSpaces()).map(spaceCores))),
    measured('shared-file index', 0, overlayIndexBytes),
    measured('activity log', [], () => localBeeDks(ACTIVITY_LOG_BEES)),
    measured('download history', [], () => localBeeDks(DOWNLOAD_HISTORY_BEES)),
  ])
  const attributed = new Set([...spaces.flatMap((s) => [...s.own, ...s.members]), ...activityLog, ...downloadHistory])
  const coreBytes = await measured('core sizes', new Map(), () => measureCoreBytes(getStore(), attributed))
  return {
    totalDiskUsage,
    storagePath: getStoragePath(),
    ...storageBreakdown({ totalDiskUsage, coreBytes, spaces, indexBytes, activityLog, downloadHistory }),
  }
}

// Boot sweep. Prunes leftover peer metadata (profile and catalog bee cores no longer tied to any
// active space) — never system bees or any raw blob core.
//
// The deletes are irreversible, so the go/no-go is sweep/sweep-rules.js and it fails closed: any gap
// in the scan refuses the WHOLE sweep, and past a floor the target set is refused above an
// absolute cap or a fraction of the store. Every pass, allowed or refused, is journaled. Metadata
// tombstones are collected by whatever compaction happens next: blocking every boot on a full-range
// pass is not acceptable.
export async function cleanupOrphanedData() {
  const { purged, refused } = await purgeLeftovers({ compact: false })
  if (refused) {
    log.warn('leftover metadata cleanup skipped this boot:', refused)
    return { purged: 0, refused }
  }
  log.info('leftover metadata cleanup done, pruned', purged, 'cores')
  return { purged, refused: null }
}
