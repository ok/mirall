// Persistence for mount records in the local `mounts-meta` bee: which disk path
// backs which share (a "mount"), on both the owned and the foreign/mirror side,
// plus per-mount sync state (enabled, status, syncedPaths, renamedPaths).
import { createLocalBee, storeEpoch } from '../core/store.js'
import { createRecordWriter } from '../core/bee-writer.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'

const log = createLogger('mount-store')

const OWNED_PREFIX = 'owned-folder-mount/'
const FOREIGN_PREFIX = 'foreign-folder-mount/'

let bee
let beeStore = -1

// The ONLY write path for a mount record — create, read-modify-write and delete alike, serialized
// per key. The read-merge helpers below each narrowed their clobber window with a fresh read; this
// closes it. The delete goes through it too, or an unmount landing mid-mutation would be undone by
// that mutation's write.
const records = createRecordWriter({ bee: () => bee, log })

const mutateOwned = (spaceId, shareId, apply) => records.mutate(ownedKey(spaceId, shareId), apply)

export async function initMounts() {
  if (bee && beeStore === storeEpoch() && !bee.core.closed) return
  beeStore = storeEpoch()
  bee = createLocalBee('mounts-meta')
  await bee.ready()
  log.info('mounts metadata initialized')
}

function ownedKey(spaceId, shareId) {
  return OWNED_PREFIX + spaceId + '/' + shareId
}

function foreignKey(spaceId, shareId) {
  return FOREIGN_PREFIX + spaceId + '/' + shareId
}

// The first write of a record that does not exist yet. Deliberately not a merge: a create cannot go
// through mutate(), which refuses a missing record.
export async function createOwnedMount(mount) {
  await records.put(ownedKey(mount.spaceId, mount.shareId), mount)
}

export async function getOwnedMount(spaceId, shareId) {
  const entry = await bee.get(ownedKey(spaceId, shareId))
  return entry?.value ?? null
}

export async function deleteOwnedMount(spaceId, shareId) {
  await records.del(ownedKey(spaceId, shareId))
}

// Durable status for an owned mount (mirrors the foreign mount.status field): the boot
// loop and probe read/write it so a scan failure survives a restart instead of living
// only in a transient renderer event. No-op when the mount record is gone (unmounted).
export function setOwnedMountStatus(spaceId, shareId, status, lastError = null) {
  return mutateOwned(spaceId, shareId, (m) =>
    (m.status === status && (m.lastError ?? null) === lastError) ? null : { ...m, status, lastError })
}

// Durable user intent: this folder's index is paused until an explicit resume. A FIELD, not a
// status, because four writers overwrite status (a scan settle, the mount-gone path, mount,
// relocate) and a pause recorded only there is lost at the next settle. No-op (false) when the
// record is gone.
export function setOwnedIndexPaused(spaceId, shareId, paused) {
  return mutateOwned(spaceId, shareId, (m) =>
    (!!m.indexPaused === !!paused) ? null : { ...m, indexPaused: !!paused })
}

// Patch an owned mount's bookkeeping. No-op (false) when the record is gone.
export function patchOwnedMount(spaceId, shareId, patch) {
  return mutateOwned(spaceId, shareId, (m) => ({ ...m, ...patch }))
}

// Stamp lastScanCompletedAt from the record as it is NOW, never from a whole mount object captured
// before a minutes-long scan — that stale write-back would clobber a status/mountPath a concurrent
// probe or relocate persisted mid-scan. No-op if unmounted.
export function touchOwnedMountScan(spaceId, shareId) {
  return mutateOwned(spaceId, shareId, (m) => ({ ...m, lastScanCompletedAt: Date.now() }))
}

export async function listOwnedMounts() {
  const out = []
  for await (const entry of bee.createReadStream({ gte: OWNED_PREFIX, lt: OWNED_PREFIX + '\xff' })) {
    out.push(entry.value)
  }
  return out
}

// The first write of a mirror record. See createOwnedMount.
export async function createForeignMount(mount) {
  await records.put(foreignKey(mount.spaceId, mount.shareId), mount)
}

// Derive a mirror record's next value from the record as it is NOW, never from a whole object a
// caller has been holding: the object a materialize pass holds was loaded before a possibly
// hours-long pass, so writing it back would clobber a pause / status / enabled flag persisted
// meanwhile. No-op (false) when the record is gone.
export function mutateForeignMount(spaceId, shareId, apply) {
  return records.mutate(foreignKey(spaceId, shareId), apply)
}

export function patchForeignMount(spaceId, shareId, patch) {
  return mutateForeignMount(spaceId, shareId, (m) => ({ ...m, ...patch }))
}

export async function getForeignMount(spaceId, shareId) {
  const entry = await bee.get(foreignKey(spaceId, shareId))
  return entry?.value ?? null
}

export async function deleteForeignMount(spaceId, shareId) {
  await records.del(foreignKey(spaceId, shareId))
}

export async function listForeignMounts() {
  const out = []
  for await (const entry of bee.createReadStream({ gte: FOREIGN_PREFIX, lt: FOREIGN_PREFIX + '\xff' })) {
    out.push(entry.value)
  }
  return out
}

export async function listAllMounts() {
  const [owned, foreign] = await Promise.all([listOwnedMounts(), listForeignMounts()])
  return [
    ...owned.map((m) => ({ ...m, role: 'owned-folder' })),
    ...foreign.map((m) => ({ ...m, role: 'foreign-folder' })),
  ]
}

export async function findOwnedMountByShareId(shareId) {
  const all = await listOwnedMounts()
  return all.find((m) => m.shareId === shareId) ?? null
}

export async function findForeignMountByShareId(shareId) {
  const all = await listForeignMounts()
  return all.find((m) => m.shareId === shareId) ?? null
}

export class MountsBee extends Subsystem {
  async _open() { await initMounts() }

  async _close() {
    const b = bee
    bee = undefined
    await b?.close()
  }
}
