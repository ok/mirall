// Persistence for mount records in the local `mounts-meta` bee: which disk path
// backs which share (a "mount"), on both the owned and the foreign/mirror side,
// plus per-mount sync state (enabled, status, syncedPaths, renamedPaths).
import { createLocalBee } from '../core/store.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('mount-store')

const OWNED_PREFIX = 'owned-folder-mount/'
const FOREIGN_PREFIX = 'foreign-folder-mount/'

let bee

export async function initMounts() {
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

export async function saveOwnedMount(mount) {
  await bee.put(ownedKey(mount.spaceId, mount.shareId), mount)
}

export async function getOwnedMount(spaceId, shareId) {
  const entry = await bee.get(ownedKey(spaceId, shareId))
  return entry?.value ?? null
}

export async function deleteOwnedMount(spaceId, shareId) {
  await bee.del(ownedKey(spaceId, shareId))
}

// Durable status for an owned mount (mirrors the foreign mount.status field): the boot
// loop and probe read/write it so a scan failure survives a restart instead of living
// only in a transient renderer event. No-op when the mount record is gone (unmounted).
export async function setOwnedMountStatus(spaceId, shareId, status, lastError = null) {
  const key = ownedKey(spaceId, shareId)
  const entry = await bee.get(key)
  if (!entry?.value) return false
  if (entry.value.status === status && (entry.value.lastError ?? null) === lastError) return true
  await bee.put(key, { ...entry.value, status, lastError })
  return true
}

// Stamp lastScanCompletedAt via a fresh read-merge rather than writing back a whole mount
// object captured before a minutes-long scan — that stale write-back would clobber a
// status/mountPath a concurrent probe or relocate persisted mid-scan. No-op if unmounted.
export async function touchOwnedMountScan(spaceId, shareId) {
  const key = ownedKey(spaceId, shareId)
  const entry = await bee.get(key)
  if (!entry?.value) return
  await bee.put(key, { ...entry.value, lastScanCompletedAt: Date.now() })
}

export async function listOwnedMounts() {
  const out = []
  for await (const entry of bee.createReadStream({ gte: OWNED_PREFIX, lt: OWNED_PREFIX + '\xff' })) {
    out.push(entry.value)
  }
  return out
}

export async function saveForeignMount(mount) {
  await bee.put(foreignKey(mount.spaceId, mount.shareId), mount)
}

// Patch a foreign mount's sync bookkeeping through a fresh read-merge, never a whole-object
// write-back: the object a materialize pass holds was loaded before a possibly hours-long pass,
// so writing it back would clobber a pause / status / enabled flag persisted meanwhile — or
// resurrect a record unmount already deleted. No-op (false) when the record is gone.
export async function patchForeignMount(spaceId, shareId, patch) {
  const key = foreignKey(spaceId, shareId)
  const entry = await bee.get(key)
  if (!entry?.value) return false
  await bee.put(key, { ...entry.value, ...patch })
  return true
}

export async function getForeignMount(spaceId, shareId) {
  const entry = await bee.get(foreignKey(spaceId, shareId))
  return entry?.value ?? null
}

export async function deleteForeignMount(spaceId, shareId) {
  await bee.del(foreignKey(spaceId, shareId))
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
