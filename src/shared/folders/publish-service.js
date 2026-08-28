// The owner-side publish service: one scheduler over per-space queues, the per-space catalog
// batch, and the channel registry the runner dispatches on. Producers — owned folders, loose
// files — only enqueue here; each registers the channel that resolves, publishes and retires
// its own kind of item, so one lane and one ordering policy cover every file the user shares.
import { createLogger } from '../core/logger.js'
import { getPublishConcurrency, getPublishOrder } from '../core/runtime-config.js'
import { createCatalogBatch } from '../shares/catalog-writer.js'
import { setPendingPublishProbe } from '../transfer/backends/overlay/overlay-backend.js'
import { LOOSE_SHARE_ID } from '../transfer/transfer-id.js'
import { createPublishScheduler } from './publish-scheduler.js'
import { createPublishRunner } from './publish-runner.js'

const log = createLogger('publish-service')

const channels = {}
export const kindOfShare = (shareId) => (shareId === LOOSE_SHARE_ID ? 'loose' : 'folder')
const channelFor = (shareId) => channels[kindOfShare(shareId)]

export function registerPublishChannel(kind, channel) {
  channels[kind] = channel
}

// Bulk publishes write through one catalog batch per space (few atomic heads for the consumer).
// A batch being closed stays tracked in `settling` until its last flush lands, so a diff or a
// resolving scan never reads the catalog ahead of writes it depends on.
const batches = new Map()
const settling = new Map()

export function catalogFor(spaceId) {
  let batch = batches.get(spaceId)
  if (!batch) batches.set(spaceId, (batch = createCatalogBatch(spaceId)))
  return batch
}

// Resolves once the batch's last flush has landed. With no batch open it still joins a close in
// progress, so an awaited "flush before X" holds whichever state the space is in.
export function closeBatch(spaceId) {
  const batch = batches.get(spaceId)
  if (!batch) return settling.get(spaceId) ?? Promise.resolve()
  batches.delete(spaceId)
  const prev = settling.get(spaceId) ?? Promise.resolve()
  const closed = prev.then(() => batch.close()).catch((err) => log.warn('catalog batch close failed:', err.message))
  settling.set(spaceId, closed)
  closed.then(() => { if (settling.get(spaceId) === closed) settling.delete(spaceId) })
  return closed
}

// Lands everything the space's catalog holds: the open batch's buffer and any flush in flight,
// then a close in progress (the flush may itself have been what the close was waiting on).
export async function settleCatalog(spaceId) {
  await batches.get(spaceId)?.flush()
  await settling.get(spaceId)
}

export const publishScheduler = createPublishScheduler({
  execute: createPublishRunner({ channels, catalogFor, settleCatalog }),
  concurrency: getPublishConcurrency,
  order: getPublishOrder,
  log,
  onProgress: (spaceId, shareId) => channelFor(shareId)?.onProgress?.(spaceId, shareId),
  // The scheduler fires onSpaceIdle (the batch close) before this, so a channel's refresh can
  // wait for the closing flush and the renderer never re-lists ahead of the pass's last writes.
  onShareDrained: (spaceId, shareId, tally) => channelFor(shareId)?.onDrained?.(spaceId, shareId, tally),
  onSpaceIdle: (spaceId) => {
    closeBatch(spaceId)
    for (const ch of Object.values(channels)) ch.onSpaceIdle?.(spaceId)
  },
})

// A cancelled RUNNING item keeps its place until its executor honours the abort (a hash polls the
// signal per chunk). Callers that must write after that tail — a direct unshare of the same path
// — wait here, bounded.
export async function whenPathIdle(spaceId, shareId, relPath, { settleMs = 5000 } = {}) {
  const deadline = Date.now() + settleMs
  while (publishScheduler.isPending(spaceId, shareId, relPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
}

export function initPublishService() {
  setPendingPublishProbe((spaceId, shareId, relPath) => publishScheduler.isPending(spaceId, shareId, relPath))
}

export async function stopPublishingForSpace(spaceId) {
  await publishScheduler.cancelSpace(spaceId)
  await closeBatch(spaceId)
}

export function stopAllPublishing() {
  publishScheduler.stop()
}

// Cancels everything, then waits (bounded) for the executors still running to honour the abort:
// a test's store closes right after this, and a tail still writing would land on a closed core.
export async function _resetPublishService() {
  publishScheduler.stop()
  const deadline = Date.now() + 5000
  while (publishScheduler._running.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  publishScheduler._reset()
  for (const batch of batches.values()) batch.close().catch(() => {})
  batches.clear()
  settling.clear()
}
