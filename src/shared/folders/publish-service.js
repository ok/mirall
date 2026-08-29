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
import { Subsystem } from '../core/subsystem.js'
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

let current = null

export class PublishService extends Subsystem {
  async _open() {
    this.scheduler = createPublishScheduler({
      execute: createPublishRunner({ channelFor, catalogFor, settleCatalog }),
      concurrency: getPublishConcurrency,
      order: getPublishOrder,
      log: this.log,
      onProgress: (spaceId, shareId) => channelFor(shareId)?.onProgress?.(spaceId, shareId),
      // The scheduler fires onSpaceIdle (the batch close) before this, so a channel's refresh can
      // wait for the closing flush and the renderer never re-lists ahead of the pass's last writes.
      onShareDrained: (spaceId, shareId, tally) => channelFor(shareId)?.onDrained?.(spaceId, shareId, tally),
      onSpaceIdle: (spaceId) => {
        closeBatch(spaceId)
        for (const ch of Object.values(channels)) ch.onSpaceIdle?.(spaceId)
      },
    })
    current = this
  }

  // Stops scheduling synchronously, so an in-flight hash unwinds during the shutdown's flush
  // window rather than after it.
  halt() { this.scheduler?.stop() }

  async _close({ settleMs = 5000 } = {}) {
    current = null
    await this.scheduler.stop({ settleMs })
    for (const batch of batches.values()) batch.close().catch(() => {})
    batches.clear()
    settling.clear()
  }
}

// Throws rather than returning null: an enqueue against a scheduler that does not exist would
// otherwise surface as a promise that never settles.
export function getPublishScheduler() {
  if (!current) throw new Error('publish service is not running')
  return current.scheduler
}


export async function stopPublishingForSpace(spaceId) {
  await current?.scheduler.cancelSpace(spaceId)
  await closeBatch(spaceId)
}
