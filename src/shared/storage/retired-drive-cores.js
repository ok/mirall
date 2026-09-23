// The two cores a per-space Hyperdrive left behind — its metadata core and the blobs core Hyperdrive
// created beside it — found by key rather than by opening a drive. Nothing reads either any more,
// and the leftover sweep never classifies them, so a leave and the one-shot retire migration are
// the only paths that delete them. The blobs manifest derives from the metadata manifest the way
// Hyperdrive derives it, so a drive's blobs key follows from its metadata key alone.
import crypto from 'hypercore-crypto'
import Hypercore from 'hypercore'
import { clearAndPurgeCore } from './core-purge.js'
import { getStore, ownParticipationPublicKey } from '../core/store.js'

const [BLOBS_NS] = crypto.namespace('hyperdrive', 1)

/** @internal */
export function blobsKeyFor(dbManifest) {
  const db = Hypercore.parseManifest(dbManifest)
  const dbKey = Hypercore.key(db)
  return Hypercore.key({
    version: db.version,
    hash: 'blake2b',
    allowPatch: db.allowPatch,
    quorum: db.quorum,
    signers: db.signers.map((s) => ({ ...s, namespace: crypto.hash([BLOBS_NS, dbKey, s.namespace]) })),
    prologue: null,
  })
}

// null when nothing is stored under the key; any other open failure propagates, so a caller never
// mistakes a core it could not read for one that is not there.
async function openStored(cs, key) {
  const core = cs.get({ key, createIfMissing: false })
  try {
    await core.ready()
    return core
  } catch (err) {
    try { await core.close() } catch {}
    if (err?.code === 'STORAGE_EMPTY') return null
    throw err
  }
}

// Deletes the drive whose metadata core has `dbKey`. `manifest` stands in when the stored core
// carries none (an own drive opened by key pair); `keepWithBlocks` leaves a drive that holds blocks
// in place. Returns { purged, clearedBlocks, kept }.
export async function purgeRetiredDrive(cs, dbKey, { manifest = null, keepWithBlocks = false } = {}) {
  const db = await openStored(cs, dbKey)
  if (!db) return { purged: 0, clearedBlocks: false, kept: false }
  let blobs = null
  try {
    const dbManifest = db.manifest || manifest
    if (dbManifest) blobs = await openStored(cs, blobsKeyFor(dbManifest))
  } catch (err) {
    await db.close()
    throw err
  }
  const cores = [db, blobs].filter(Boolean)
  const clearedBlocks = cores.some((core) => core.length > 0)
  if (clearedBlocks && keepWithBlocks) {
    for (const core of cores) await core.close()
    return { purged: 0, clearedBlocks: false, kept: true }
  }
  for (const core of cores) await clearAndPurgeCore(cs, core)
  return { purged: cores.length, clearedBlocks, kept: false }
}

// This peer's own drive for a space: opened by the participation key pair, so the manifest is the
// single-signer one a Corestore writes for it.
export async function purgeOwnRetiredDrive(space, { keepWithBlocks = false } = {}) {
  const publicKey = ownParticipationPublicKey(space.spaceId, space.driveSuffix)
  if (!publicKey) return { purged: 0, clearedBlocks: false, kept: false }
  return purgeRetiredDrive(getStore(), Hypercore.key(publicKey), { manifest: { signers: [{ publicKey }] }, keepWithBlocks })
}
