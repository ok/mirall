// Persistence for mount records in the local `mounts-meta` bee: which disk path
// backs which share (a "mount"), on both the owned and the foreign/mirror side,
// plus per-mount sync state (enabled, status, syncedPaths, renamedPaths).
//
// Two key namespaces, one record shape: `owned-folder-mount/<spaceId>/<shareId>` and
// `foreign-folder-mount/<spaceId>/<shareId>`. A record is created whole with spaceId, shareId,
// mountPath, enabled and status, and every later writer patches it — which is why no single site
// shows the shape. What the patches add: `lastError` and `indexPaused` (contract/statuses.js states
// what the three status fields mean together), `syncedPaths` and `renamedPaths` from the mirror's
// pass, and `lastScanCompletedAt` from the owner's.
import { createLocalBee, storeEpoch } from '../core/store.js'
import { createRecordWriter } from '../core/bee-writer.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { prefixRange } from '../core/bee-keys.js'
import { ownedMountStatus } from '../contract/mount-precedence.js'
import { AppError } from '../core/errors.js'
import { CODES } from '../contract/errors.js'

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

// test seam — production opens the mounts bee through this file's own _open()
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

// `status` is derived from the two facts beside it, never assigned: the three setters below name a
// fact and this resolves it. No-op when nothing changed, so a probe tick that re-asserts the same
// state appends no block.
function applied(m, patch) {
  const next = { ...m, ...patch }
  next.status = ownedMountStatus(next)
  next.lastError = next.lastError ?? null
  const same = m.status === next.status
    && (m.lastError ?? null) === (next.lastError ?? null)
    && !!m.indexPaused === !!next.indexPaused
  return same ? null : next
}

// A pass reached a conclusion about the source: it is readable, and this is where it got to.
// Clears a recorded fault — a pass that ran is the evidence it is gone — and cannot disturb a pause.
export function setOwnedActivity(spaceId, shareId, activity) {
  return mutateOwned(spaceId, shareId, (m) => applied(m, { status: activity, lastError: null }))
}

// A pass could not finish, and this is why. Outranks a pause without erasing it.
export function setOwnedFault(spaceId, shareId, faultStatus, code = null) {
  return mutateOwned(spaceId, shareId, (m) => applied(m, { status: faultStatus, lastError: code }))
}

// Durable user intent: this folder's index is paused until an explicit resume. Kept beside `status`
// rather than in it, so a fault showing over the pause does not erase it.
export function setOwnedIndexPaused(spaceId, shareId, paused) {
  return mutateOwned(spaceId, shareId, (m) => applied(m, { indexPaused: !!paused }))
}

const DERIVED_FIELDS = ['status', 'indexPaused']

// Patch an owned mount's bookkeeping. No-op (false) when the record is gone.
export function patchOwnedMount(spaceId, shareId, patch) {
  for (const field of DERIVED_FIELDS) {
    if (field in patch) {
      throw new AppError(CODES.INVALID_ARGUMENT,
        `mount ${field} is derived — use setOwnedActivity, setOwnedFault or setOwnedIndexPaused`)
    }
  }
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
  for await (const entry of bee.createReadStream(prefixRange(OWNED_PREFIX))) {
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
  for await (const entry of bee.createReadStream(prefixRange(FOREIGN_PREFIX))) {
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

export class MountsBee extends Subsystem {
  async _open() { await initMounts() }

  async _close() {
    const b = bee
    bee = undefined
    await b?.close()
  }
}
