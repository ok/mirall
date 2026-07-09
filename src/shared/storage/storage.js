// Storage accounting + reclaim behind the Storage screen: measure the store's disk
// footprint (per-space drives, overlay index, database remainder) and run the
// cleanup passes — a boot-time metadata sweep and the user-driven free-space action.
import fs from 'bare-fs'
import path from 'bare-path'
import { createLogger } from '../core/logger.js'
import { listSpaces, getDrive } from '../spaces/space.js'
import { getStoragePath } from '../core/store.js'
import { purgeLeftovers } from './leftover.js'

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

export async function getStorageInfo() {
  const totalDiskUsage = getDirSize(getStoragePath())

  const spaces = await listSpaces()
  const perSpace = []
  let activeSpacesTotal = 0

  for (const space of spaces) {
    const drive = getDrive(space.spaceId)
    if (!drive) continue
    try {
      await drive.ready()
      // Overlay copies no bytes into the per-space drive (it serves straight from
      // the source file), so the only retained bytes are the drive's metadata core.
      const metadataBytes = drive.core.byteLength
      const totalBytes = metadataBytes
      activeSpacesTotal += totalBytes
      perSpace.push({
        spaceId: space.spaceId,
        name: space.name,
        icon: space.icon,
        metadataBytes,
        contentBytes: 0,
        totalBytes,
      })
    } catch (err) {
      log.warn('cannot measure drive:', space.name, err.message)
    }
  }

  let indexBytes = 0
  try {
    const { getOverlayLocalByteLength } = await import('../transfer/backends/overlay/overlay-instance.js')
    indexBytes = await getOverlayLocalByteLength()
  } catch (err) { log.warn('overlay index size failed:', err.message) }
  const dbBytes = Math.max(0, totalDiskUsage - activeSpacesTotal - indexBytes)

  return {
    totalDiskUsage,
    storagePath: getStoragePath(),
    spaces: perSpace,
    indexBytes,
    dbBytes,
  }
}

// One-click reclaim for the Storage screen: rebuild the overlay index without dead
// chunk maps and purge orphaned peer metadata, then report the disk actually freed.
// Non-destructive — only unreferenced data is dropped.
export async function freeSpace() {
  const before = getDirSize(getStoragePath())
  let changed = false
  try {
    const { compactOverlayIndex } = await import('../transfer/backends/overlay/overlay-backend.js')
    if ((await compactOverlayIndex()).compacted) changed = true
  } catch (err) { log.warn('index compaction failed:', err.message) }
  try { if ((await purgeLeftovers()).purged > 0) changed = true } catch (err) { log.warn('leftover purge failed:', err.message) }
  // Nothing reclaimed → the store is unchanged; skip the second full-tree stat walk.
  if (!changed) return { freedBytes: 0 }
  const after = getDirSize(getStoragePath())
  return { freedBytes: Math.max(0, before - after) }
}

async function readDriveBytes(drive) {
  await drive.ready()
  return drive.core.byteLength
}

export async function getSpaceCacheBytes(spaceId) {
  const localDrive = getDrive(spaceId)
  if (!localDrive) return 0
  try {
    return await readDriveBytes(localDrive)
  } catch (err) {
    log.warn('cannot measure local drive for space:', spaceId, err.message)
    return 0
  }
}

// Boot-time / maintenance sweep. Prunes only leftover peer metadata (profile and
// catalog bee cores no longer tied to any active space) — never system bees,
// active drives, or any raw blob/drive core, so it can never delete live peer
// content. Orphan-drive reclamation is deliberately excluded here: it can free
// gigabytes, so it is user-driven (with a preview), not silent at boot.
export async function cleanupOrphanedData() {
  const { purged } = await purgeLeftovers({ categories: ['profiles', 'catalogs'] })
  log.info('leftover metadata cleanup done, pruned', purged, 'cores')
  return { purged }
}
