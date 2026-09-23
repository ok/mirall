// Durable registry of unfinished downloads: one row per (spaceId, filePath) in the local
// `pending-transfers` bee, keyed `<spaceId>:<filePath>`. A row is written when a download
// starts, updated with byte progress and error codes, and cleared on completion — surviving
// rows are what drive resume after a restart and the paused/error states the UI derives.
import { createLocalBee, storeEpoch } from '../core/store.js'
import { createKeyedLock } from '../core/concurrency.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { prefixRange } from '../core/bee-keys.js'

const log = createLogger('pending-transfers')

let bee
let beeStore = -1
// Every write to one row goes through here in call order. A progress tick issued after an
// error write (chunks still landing after a mismatch) would otherwise read the row before the
// verdict and put it back without one.
const exclusive = createKeyedLock()
const rowKey = (spaceId, filePath) => spaceId + ':' + filePath

/** @internal production opens the bee through this file's own _open() */
export async function initPendingTransfers() {
  if (bee && beeStore === storeEpoch() && !bee.core.closed) return
  beeStore = storeEpoch()
  bee = createLocalBee('pending-transfers')
  await bee.ready()
  log.info('pending transfers initialized')
}

// The live bee, for tests that need a write to fail. Not for production callers.
/** @internal */
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

// `refusedByPreflight` names the check that produced the verdict, which is what decides whether the
// same check passing later is evidence the fault cleared. It is written on every error, so a second
// verdict cannot inherit the first one's answer.
export function recordPendingError(spaceId, filePath, errorCode, { refusedByPreflight = false } = {}) {
  const key = rowKey(spaceId, filePath)
  return exclusive(key, async () => {
    const cur = await bee.get(key)
    if (!cur) return
    await bee.put(key, {
      ...cur.value,
      errorCode,
      erroredAt: Date.now(),
      refusedByPreflight,
    })
  })
}

async function* pendingRows() {
  for await (const entry of bee.createReadStream()) {
    const sep = entry.key.indexOf(':')
    if (sep < 0) continue
    yield { spaceId: entry.key.slice(0, sep), filePath: entry.key.slice(sep + 1), ...entry.value }
  }
}

export async function listPending() {
  const out = []
  for await (const row of pendingRows()) out.push(row)
  return out
}

export async function listPendingForSpace(spaceId) {
  const out = []
  for await (const entry of bee.createReadStream(prefixRange(spaceId + ':'))) {
    out.push({
      spaceId,
      filePath: entry.key.slice(spaceId.length + 1),
      ...entry.value,
    })
  }
  return out
}

// The owned rows `keep` accepts, in one bee scan; `keep` sees each row as listPending returns it.
// Both convergence-tick reads go through here, so each is one scan.
async function keptPendingRows(keep) {
  const out = []
  for await (const row of pendingRows()) {
    if (typeof row.ownerKey === 'string' && row.ownerKey !== '' && keep(row)) out.push(row)
  }
  return out
}

// Owners of the rows `keep` accepts, deduped.
export async function listPendingOwnerKeys({ keep }) {
  return new Set((await keptPendingRows(keep)).map((row) => row.ownerKey))
}

// The (owner, space) pairs of the rows `keep` accepts, deduped: the key a reconcile is driven by.
export async function listPendingOwnerSpaces({ keep }) {
  const pairs = new Map()
  for (const row of await keptPendingRows(keep)) {
    pairs.set(row.ownerKey + ':' + row.spaceId, { ownerKey: row.ownerKey, spaceId: row.spaceId })
  }
  return [...pairs.values()]
}

// Leave-time purge. The deletes run through the SAME per-key chain as every single-row write,
// so a recordPending/updatePendingProgress already queued for one of these rows cannot land
// after the purge and resurrect a row for a space the user just left.
export async function clearPendingForSpace(spaceId) {
  const keys = []
  for await (const entry of bee.createReadStream(prefixRange(spaceId + ':'))) {
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
