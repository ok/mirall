// Durable registry of unfinished downloads: one row per (spaceId, filePath) in the local
// `pending-transfers` bee, keyed `<spaceId>:<filePath>`. A row is written when a download
// starts, updated with byte progress and error codes, and cleared on completion — surviving
// rows are what drive resume after a restart and the paused/error states the UI derives.
import { createLocalBee } from '../core/store.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('pending-transfers')

let bee

export async function initPendingTransfers() {
  bee = createLocalBee('pending-transfers')
  await bee.ready()
  log.info('pending transfers initialized')
}

export async function recordPending(spaceId, filePath, info) {
  await bee.put(spaceId + ':' + filePath, { ...info, updatedAt: Date.now() })
}

export async function updatePendingProgress(spaceId, filePath, bytes) {
  const key = spaceId + ':' + filePath
  const cur = await bee.get(key)
  if (!cur) return
  await bee.put(key, { ...cur.value, bytesTransferred: bytes, updatedAt: Date.now() })
}

export async function clearPending(spaceId, filePath) {
  await bee.del(spaceId + ':' + filePath)
}

export async function getPendingFor(spaceId, filePath) {
  const entry = await bee.get(spaceId + ':' + filePath)
  return entry?.value || null
}

export async function recordPendingError(spaceId, filePath, errorCode) {
  const key = spaceId + ':' + filePath
  const cur = await bee.get(key)
  if (!cur) return
  await bee.put(key, {
    ...cur.value,
    errorCode,
    erroredAt: Date.now(),
  })
}

export async function clearPendingError(spaceId, filePath) {
  const key = spaceId + ':' + filePath
  const cur = await bee.get(key)
  if (!cur?.value?.errorCode) return
  const next = { ...cur.value }
  delete next.errorCode
  delete next.erroredAt
  await bee.put(key, next)
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

export async function clearPendingForSpace(spaceId) {
  const batch = bee.batch()
  for await (const entry of bee.createReadStream({ gte: spaceId + ':', lt: spaceId + ';' })) {
    await batch.del(entry.key)
  }
  await batch.flush()
}
