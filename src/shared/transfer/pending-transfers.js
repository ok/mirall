// Durable registry of unfinished downloads: one row per (spaceId, filePath) in the local
// `pending-transfers` bee, keyed `<spaceId>:<filePath>`. A row is written when a download
// starts, updated with byte progress and error codes, and cleared on completion — surviving
// rows are what drive resume after a restart and the paused/error states the UI derives.
import { createLocalBee, storeEpoch } from '../core/store.js'
import { createKeyedLock } from '../core/keyed-lock.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'

const log = createLogger('pending-transfers')

let bee
let beeStore = -1
// Every write to one row goes through here in call order. A progress tick issued after an
// error write (chunks still landing after a mismatch) would otherwise read the row before the
// verdict and put it back without one.
const exclusive = createKeyedLock()
const rowKey = (spaceId, filePath) => spaceId + ':' + filePath

export async function initPendingTransfers() {
  if (bee && beeStore === storeEpoch() && !bee.core.closed) return
  beeStore = storeEpoch()
  bee = createLocalBee('pending-transfers')
  await bee.ready()
  log.info('pending transfers initialized')
}

// The live bee, for tests that need a write to fail. Not for production callers.
export function _pendingBeeForTests() {
  return bee
}

export function recordPending(spaceId, filePath, info) {
  const key = rowKey(spaceId, filePath)
  return exclusive(key, () => bee.put(key, { ...info, updatedAt: Date.now() }))
}

export function updatePendingProgress(spaceId, filePath, bytes) {
  const key = rowKey(spaceId, filePath)
  return exclusive(key, async () => {
    const cur = await bee.get(key)
    if (!cur) return
    await bee.put(key, { ...cur.value, bytesTransferred: bytes, updatedAt: Date.now() })
  })
}

export function clearPending(spaceId, filePath) {
  const key = rowKey(spaceId, filePath)
  return exclusive(key, () => bee.del(key))
}

export async function getPendingFor(spaceId, filePath) {
  const entry = await bee.get(spaceId + ':' + filePath)
  return entry?.value || null
}

export function recordPendingError(spaceId, filePath, errorCode) {
  const key = rowKey(spaceId, filePath)
  return exclusive(key, async () => {
    const cur = await bee.get(key)
    if (!cur) return
    await bee.put(key, {
      ...cur.value,
      errorCode,
      erroredAt: Date.now(),
    })
  })
}

export function clearPendingError(spaceId, filePath) {
  const key = rowKey(spaceId, filePath)
  return exclusive(key, async () => {
    const cur = await bee.get(key)
    if (!cur?.value?.errorCode) return
    const next = { ...cur.value }
    delete next.errorCode
    delete next.erroredAt
    await bee.put(key, next)
  })
}

export async function listPending() {
  const out = []
  for await (const entry of bee.createReadStream()) {
    const sep = entry.key.indexOf(':')
    if (sep < 0) continue
    out.push({
      spaceId: entry.key.slice(0, sep),
      filePath: entry.key.slice(sep + 1),
      ...entry.value,
    })
  }
  return out
}

export async function listPendingForSpace(spaceId) {
  const out = []
  for await (const entry of bee.createReadStream({ gte: spaceId + ':', lt: spaceId + ';' })) {
    out.push({
      spaceId,
      filePath: entry.key.slice(spaceId.length + 1),
      ...entry.value,
    })
  }
  return out
}

// Owners we are still waiting on bytes from, deduped. Read on every convergence tick, so it stays
// a bee scan with no per-row resolution.
export async function listPendingOwnerKeys() {
  const owners = new Set()
  for await (const entry of bee.createReadStream()) {
    const ownerKey = entry.value?.ownerKey
    if (typeof ownerKey === 'string' && ownerKey) owners.add(ownerKey)
  }
  return owners
}

// Leave-time purge. The deletes run through the SAME per-key chain as every single-row write,
// so a recordPending/updatePendingProgress already queued for one of these rows cannot land
// after the purge and resurrect a row for a space the user just left.
export async function clearPendingForSpace(spaceId) {
  const keys = []
  for await (const entry of bee.createReadStream({ gte: spaceId + ':', lt: spaceId + ';' })) {
    keys.push(entry.key)
  }
  await Promise.all(keys.map((key) => exclusive(key, () => bee.del(key))))
}

export class PendingTransfersBee extends Subsystem {
  async _open() { await initPendingTransfers() }

  async _close() {
    const b = bee
    bee = undefined
    await b?.close()
  }
}
