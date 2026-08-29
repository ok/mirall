// The owner-side publish service: one scheduler over per-space queues, the per-space catalog
// batch, and the channel registry the runner dispatches on. Producers — owned folders, loose
// files — only enqueue here; each registers the channel that resolves, publishes and retires
// its own kind of item, so one lane and one ordering policy cover every file the user shares.
//
// Imports nothing from the transfer layer beyond the loose share id: the loose producer imports
// this module and registers its channel at load time, so a path from here back to it would put
// `channels` in its temporal dead zone for whichever module happens to be imported first.
import { createLogger } from '../core/logger.js'
import { getPublishConcurrency, getPublishOrder } from '../core/runtime-config.js'
import { createCatalogBatch } from '../shares/catalog-writer.js'
import { LOOSE_SHARE_ID } from '../transfer/transfer-id.js'
import { createPublishScheduler } from './publish-scheduler.js'
import { createPublishRunner } from './publish-runner.js'

const log = createLogger('publish-service')

// A channel is a pure function of the share id: the loose pseudo-share, else a folder share.
const channels = {}
export const channelFor = (shareId) => channels[shareId === LOOSE_SHARE_ID ? 'loose' : 'folder']

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
  execute: createPublishRunner({ channelFor, catalogFor, settleCatalog }),
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

export async function stopPublishingForSpace(spaceId) {
  await publishScheduler.cancelSpace(spaceId)
  await closeBatch(spaceId)
}

export function stopAllPublishing() {
  publishScheduler.stop()
}

// Cancels everything and waits (bounded) for the executors still running to honour the abort:
// the store closes right after this, and a tail still writing would land on a closed core.
export async function closePublishService({ settleMs = 5000 } = {}) {
  await publishScheduler.stop({ settleMs })
  for (const batch of batches.values()) batch.close().catch(() => {})
  batches.clear()
  settling.clear()
}

// The scheduler is constructed at module level, and stop() sets a `stopped` flag only _reset()
// clears — so a second boot in the same process would inherit a dead lane: every publish would
// queue and nothing would ever pump it, and onFsEvent's promise would never settle. The boot root
// calls this before it wires the owned-folder subsystem. It goes away in Phase 2, when the
// scheduler becomes a resource the root constructs fresh.
export function armPublishService() {
  publishScheduler._reset()
}

// The test seam: the stop plus the arm, for a helper that tears a peer down and boots another in
// the same process. Retired in Phase 2 with the module-level scheduler.
export async function _resetPublishService() {
  await closePublishService()
  armPublishService()
}
