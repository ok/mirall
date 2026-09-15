// This peer's own writable Hyperdrive for each space: the live drive per space, how one is
// named, opened, announced to co-members, loaded at boot and purged on leave.
//
// The drive name carries an optional per-participation suffix. It decouples drive identity
// across rejoins: a peer who leaves and rejoins gets a fresh suffix, so others see the new
// participation as a new drive (empty) rather than the deterministic-key resurrection of the
// old one. Records without a suffix resolve to the plain unsuffixed name.
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { createDrive, getStore, isStorageInconsistency } from '../core/store.js'
import { markSpaceDriveKey, markSpaceLooseCatalogKey, markSpaceLooseCatalogKeyEnc } from './profile.js'
import { ownLooseCatalogPublish } from '../shares/own-catalog.js'
import { purgeCoreDk } from '../storage/core-purge.js'
import { listSpaces, mutateSpace, deleteSpaceRecord, getSpaceContentKey } from './space.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'

const log = createLogger('space-drives')

const drives = new Map()

function makeDriveName(spaceId, driveSuffix) {
  return driveSuffix
    ? 'space-drive-' + spaceId + '-' + driveSuffix
    : 'space-drive-' + spaceId
}

export function makeDriveSuffix() {
  return b4a.toString(crypto.randomBytes(8), 'hex')
}

export function getDrive(spaceId) {
  return drives.get(spaceId)
}

// Forget the live drive without touching its on-disk cores, so a later purgeSpaceDrive can
// still free them.
export function dropDrive(spaceId) {
  drives.delete(spaceId)
}

async function readySpaceDrive(spaceId, driveSuffix, sck) {
  const drive = createDrive(makeDriveName(spaceId, driveSuffix), { encryptionKey: sck })
  await drive.ready()
  return drive
}

// Open this peer's drive for a space and register it as the live one.
export async function openOwnDrive(spaceId, driveSuffix, sck) {
  const drive = await readySpaceDrive(spaceId, driveSuffix, sck)
  drives.set(spaceId, drive)
  return drive
}

// Publish our per-space loose-catalog key alongside the drive key so co-members fold it from
// records (the same path driveKey uses). Requires the space RECORD to exist — the key derives
// from it through the catalog's name — so callers pass the record they already hold, which
// adds no extra read and never publishes before the record is saved.
export async function publishLooseCatalogKey(spaceId, space) {
  if (!space) { log.warn('skipping loose-catalog key publish — no space record:', spaceId); return }
  const pub = await ownLooseCatalogPublish(spaceId)
  if (!pub) return
  try {
    if (pub.encrypted) await markSpaceLooseCatalogKeyEnc(spaceId, pub.keyHex)
    else await markSpaceLooseCatalogKey(spaceId, pub.keyHex)
  } catch (err) { log.debug('loose-catalog key publish failed:', err.message) }
}

// Tell co-members how to read our content: the drive key so they can open it (including ones
// who only derive us from records), then the loose-catalog key. Both are idempotent.
export async function announceOwnDrive(spaceId, space, drive) {
  await markSpaceDriveKey(spaceId, b4a.toString(drive.key, 'hex'))
  await publishLooseCatalogKey(spaceId, space)
}

function openSpaceDrive(space) {
  return readySpaceDrive(space.spaceId, space.driveSuffix, getSpaceContentKey(space.spaceId, space))
}

async function recordDriveLoadFailure(space, err) {
  if (isStorageInconsistency(err)) {
    // The core's own tree cannot back its length: no retry will open this drive. Drop the
    // record; the leftover sweep can reclaim its cores.
    log.error('drive storage inconsistent for', space.spaceId, '-', err.message, '- dropping space record')
    try { await deleteSpaceRecord(space.spaceId) } catch (delErr) {
      log.warn('could not drop the space record:', space.spaceId, '-', delErr.message)
    }
    return
  }
  // Anything else may be transient (a lock still held by a dying instance, disk pressure, a
  // half-written core). Keep the space, mark it, and let the next boot retry: deleting the
  // record costs the user the space outright, which a transient fault must not do.
  log.error('drive load failed for', space.spaceId, '-', err.message, '- keeping the space record for retry')
  await mutateSpace(space.spaceId, (s) => ({ ...s, driveLoadError: { message: err.message, at: Date.now() } }))
    .catch((mErr) => log.warn('could not mark the drive-load failure:', space.spaceId, '-', mErr.message))
}

// test seam
export async function loadDrives({ openDrive = openSpaceDrive } = {}) {
  let hadFailure = false
  for (const space of await listSpaces()) {
    // A leaving space's drive must not come back up either: loadDrives runs before the boot
    // completion pass, so the marker is the only thing keeping it down.
    if (space.status === 'pending' || space.leaving) continue
    let drive
    try {
      drive = await openDrive(space)
    } catch (err) {
      hadFailure = true
      await recordDriveLoadFailure(space, err)
      continue
    }
    drives.set(space.spaceId, drive)
    if (space.driveLoadError) {
      await mutateSpace(space.spaceId, (s) => { const next = { ...s }; delete next.driveLoadError; return next })
        .catch((mErr) => log.warn('could not clear the drive-load marker:', space.spaceId, '-', mErr.message))
    }
    // Idempotent backfills, re-run every boot. Not part of loading the drive: a profile or
    // catalog write that fails must not cost the space its record.
    try {
      await announceOwnDrive(space.spaceId, space, drive)
    } catch (err) {
      log.warn('post-load backfill failed for', space.spaceId, '-', err.message)
    }
  }
  return { hadFailure }
}

// Release a SPACE drive's own core sessions. A space cannot exist without the master secret
// (createSpace/joinSpace refuse without one), so a space drive is always the explicit-keypair
// shape: built over the ROOT corestore via the `_db` Hyperdrive ctor path. drive.close() would
// therefore close that root and kill every other session — the "RocksDB session is closed" /
// "closing core" cascade. Close just this drive's own cores instead; the root stays open and
// whatever runs next still has a store. (createDrive's namespaced branch is still reachable for
// drives that are not a space's — nothing here opens one.)
async function releaseDriveCores(drive, blobs) {
  try {
    if (blobs) await blobs.core.close()
    if (drive.db) await drive.db.close()
  } catch (err) {
    log.warn('drive core release failed:', err.message)
  }
}

export async function purgeSpaceDrive(spaceId, onProgress, { compact = true } = {}) {
  const drive = drives.get(spaceId)
  if (!drive) {
    log.warn('no drive found for space', spaceId)
    return
  }

  const cs = getStore()
  const db = cs.storage.db
  const emit = (phase) => { if (onProgress) onProgress(phase) }
  drives.delete(spaceId)

  try {
    await drive.ready()
    const metaDk = b4a.toString(drive.core.discoveryKey, 'hex')
    const blobs = await drive.getBlobs()
    const blobsDk = blobs ? b4a.toString(blobs.core.discoveryKey, 'hex') : null

    // Clear the drive's blocks before the header delete so RocksDB accounts blob
    // garbage; purgeCoreDk alone strands blob-separated values (garbage stays 0).
    try { await drive.clearAll() } catch (err) { log.warn('drive clearAll before purge failed:', err.message) }

    await releaseDriveCores(drive, blobs)

    emit('purgingLocalMeta')
    // A space drive opens by keyPair, not name (see releaseDriveCores), so there is no
    // (namespace, 'db') alias to purge — drive.corestore.ns is the root namespace, which
    // purgeAlias must not touch.
    await purgeCoreDk(cs, metaDk)
    emit('purgingLocalBlobs')
    if (blobsDk) await purgeCoreDk(cs, blobsDk)

    emit('compactingLocalCache')
    // The cores are already tombstoned (purgeCoreDk above); the compaction only reclaims the
    // bytes. It is a full-range pass (scales with the WHOLE store, not this space), so callers that
    // leave can defer it to a single background pass instead of blocking on it per-drive.
    if (compact) {
      await db.compactRange(null, null, {
        blobGarbageCollectionPolicy: 1,
        blobGarbageCollectionAgeCutoff: 1.0,
        bottommostLevelCompaction: 2,
      })
    }
    log.info('purged local drive for space', spaceId)
  } catch (err) {
    log.warn('failed to purge drive for space', spaceId, err.message)
    // Best-effort release of the meta core's exclusive lock — never drive.close()
    // here, which would close the root corestore in identity mode.
    try { if (drive.db) await drive.db.close() } catch {}
  } finally {
    emit('finalizing')
    try { await db.flush() } catch (err) {
      log.warn('flush after purgeSpaceDrive failed:', err.message)
    }
  }
}

// Split from SpacesBee because the audit log, the serve ledger and the catalog cache all start
// between the space record opening and the drives loading.
export class SpaceDrives extends Subsystem {
  async _open() { this.load = await loadDrives() }

  // Releases each drive's own cores rather than closing the drive: the root corestore must
  // survive, because the tiers that close after this one still read and write through it — the
  // serve ledger's flush resolves each space to record its audit row, and the store's own close
  // is what finally releases the lock.
  async _close() {
    const open = [...drives.values()]
    drives.clear()
    await Promise.allSettled(open.map(async (drive) => {
      const blobs = await drive.getBlobs().catch(() => null)
      await releaseDriveCores(drive, blobs)
    }))
  }
}
