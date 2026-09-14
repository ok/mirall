// The owner-side publish service: one scheduler over per-space queues, the per-space catalog
// batch, and the channel registry the runner dispatches on. Producers — owned folders, loose
// files — only enqueue here; each registers the channel that resolves, publishes and retires
// its own kind of item, so one lane and one ordering policy cover every file the user shares.
//
// Imports nothing from the transfer layer beyond the loose share id: the loose producer imports
// this module and registers its channel at load time, so a path from here back to it would put
// `channels` in its temporal dead zone for whichever module happens to be imported first.
import { createLogger } from '../core/logger.js'
import { getPublishConcurrency, getPublishOrder, getPublishStallWindowMs } from '../core/runtime-config.js'
import { createCatalogBatch } from '../shares/catalog-writer.js'
import { LOOSE_SHARE_ID } from '../transfer/transfer-id.js'
import { Subsystem } from '../core/subsystem.js'
import { createPublishScheduler } from './publish-scheduler.js'
import fs from 'bare-fs'
import { OP, PRIORITY } from './work-item.js'
import { fileExactlyPresent } from './disk-presence.js'

const log = createLogger('publish-service')

// A channel is a pure function of the share id: the loose pseudo-share, else a folder share.
const channels = {}
const channelFor = (shareId) => channels[shareId === LOOSE_SHARE_ID ? 'loose' : 'folder']

export function registerPublishChannel(kind, channel) {
  channels[kind] = channel
}

// Bulk publishes write through one catalog batch per space (few atomic heads for the consumer).
// A batch being closed stays tracked in `settling` until its last flush lands, so a diff or a
// resolving scan never reads the catalog ahead of writes it depends on.
const batches = new Map()
const settling = new Map()

function catalogFor(spaceId) {
  let batch = batches.get(spaceId)
  if (!batch) batches.set(spaceId, (batch = createCatalogBatch(spaceId)))
  return batch
}

// Resolves once the batch's last flush has landed. With no batch open it still joins a close in
// progress, so an awaited "flush before X" holds whichever state the space is in.
function closeBatch(spaceId) {
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

  // One unit per item holding a slot and not advancing. The lane is shared by every space, so a
  // wedged item is not one share's problem: at the shipped concurrency three of them stop
  // publishing everywhere. The label is the path — the worker log names a unit; the redacted
  // health report below counts them.
  supervise({ now = Date.now() } = {}) {
    if (this.closed || this.stopping || !this.scheduler) return []
    return this.scheduler.stalledItems({ now, windowMs: getPublishStallWindowMs() })
      .map((row) => ({
        key: row.key,
        ok: row.ok,
        detail: row.detail,
        label: row.shareId + ' ' + row.relPath,
        // An item whose slot has already been reclaimed has no second recovery: the executor is
        // past anything we can reach, and evicting it again is a no-op. Reported for as long as it
        // is still out there — which is what keeps its strike counter alive and its wedge in the
        // health report — but never acted on again.
        recoverable: !row.evicted,
      }))
  }

  // Reclaim the slot. The item stays in the queue until its executor returns, so the path it holds
  // cannot get a second executor and the file is never hashed twice.
  async recover(key) {
    if (this.stopping) return
    this.scheduler?.evict(key)
  }

  health() {
    const open = !this.closed && !this.stopping
    if (!open) return { ok: false, detail: null }
    const wedged = this.scheduler?.stalledItems({ windowMs: getPublishStallWindowMs() }) ?? []
    return {
      ok: wedged.length === 0,
      detail: wedged.length ? `${wedged.length} publish item(s) not advancing` : null,
      publishes: { wedged: wedged.length },
    }
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

// Turns a work item into catalog + overlay effects through the channel for its share. Every item
// re-derives its precondition from CURRENT state at execution time, never from the facts it was
// enqueued with: an item can sit in the lane for minutes, and in that time the mount may have
// been relocated, its root unplugged, or a loose source unshared.

export function mountRootAvailable(mountPath) {
  try {
    return fs.statSync(mountPath).isDirectory()
  } catch {
    return false
  }
}

// channel: {
//   direct?         — never writes through the space batch (so no batch is settled or opened)
//   present?(abs)   — how "still on disk" is judged before a retire; exact readdir name by default
//   resolve(item)   → { absPath, ...channel-private } | { skip: outcome }
//   publish(item, ctx, { catalog, signal, deep, beat }) → { changed, ... }
//   retire(item, ctx, { catalog })
//   onPublishFailed?(item, ctx, err), afterPublish?(item, ctx, result)
//   onProgress?(spaceId, shareId), onDrained?(spaceId, shareId, tally), onSpaceIdle?(spaceId)
// }
export function createPublishRunner({ channelFor, catalogFor, settleCatalog }) {
  // `beat` is the item's heartbeat: the scheduler reports an item that is running and not
  // advancing as wedged, and every phase here is legitimately slow on a large share. Resolving the
  // mount hits the disk and the catalog settle waits on a flush window — a phase that reports
  // nothing is a phase the stall window has to be widened to tolerate.
  return async function execute(item, { beat = () => {} } = {}) {
    const channel = channelFor(item.shareId)
    if (!channel) return { outcome: 'failed' }
    const ctx = await channel.resolve(item)
    if (ctx.skip) return { outcome: ctx.skip }
    beat()

    // Bulk items write through the space's catalog batch (few atomic heads for the consumer). An
    // interactive item goes direct so a dropped-in file is visible within milliseconds — after
    // landing whatever the batch still holds for the space, so a staged put or tombstone for the
    // same path can never land after the direct write and undo it. A direct channel never stages
    // anything, so it neither waits for the batch nor opens one.
    const interactive = item.priority === PRIORITY.INTERACTIVE
    if (interactive && !channel.direct) await settleCatalog(item.spaceId)
    beat()
    const catalog = interactive || channel.direct ? undefined : catalogFor(item.spaceId)

    if (item.op === OP.RETIRE) {
      // Absence from a stale observation is a candidate; only a file that is really gone is a
      // delete. A tombstone replicates to every peer. A key with no path behind it (poison, or a
      // loose entry whose source link is gone) is reclaimed.
      const present = channel.present ?? fileExactlyPresent
      if (ctx.absPath && present(ctx.absPath)) return { outcome: 'skipped-still-present' }
      await channel.retire(item, ctx, { catalog })
      return { outcome: 'retired' }
    }
    if (!ctx.absPath) return { outcome: 'failed' }

    let result
    try {
      result = await channel.publish(item, ctx, { catalog, signal: item.signal, deep: item.deep, beat })
    } catch (err) {
      await channel.onPublishFailed?.(item, ctx, err)
      throw err
    }
    await channel.afterPublish?.(item, ctx, result)
    return { outcome: result?.changed ? 'published' : 'unchanged' }
  }
}
