// Turns a work item into catalog + overlay effects through the channel for its share. Every item
// re-derives its precondition from CURRENT state at execution time, never from the facts it was
// enqueued with: an item can sit in the lane for minutes, and in that time the mount may have
// been relocated, its root unplugged, or a loose source unshared.
import fs from 'bare-fs'
import { OP, PRIORITY } from './work-item.js'
import { fileExactlyPresent } from './disk-presence.js'

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
//   publish(item, ctx, { catalog, signal, deep }) → { changed, ... }
//   retire(item, ctx, { catalog })
//   onPublishFailed?(item, ctx, err), afterPublish?(item, ctx, result)
//   onProgress?(spaceId, shareId), onDrained?(spaceId, shareId, tally), onSpaceIdle?(spaceId)
// }
export function createPublishRunner({ channelFor, catalogFor, settleCatalog }) {
  return async function execute(item) {
    const channel = channelFor(item.shareId)
    if (!channel) return { outcome: 'failed' }
    const ctx = await channel.resolve(item)
    if (ctx.skip) return { outcome: ctx.skip }

    // Bulk items write through the space's catalog batch (few atomic heads for the consumer). An
    // interactive item goes direct so a dropped-in file is visible within milliseconds — after
    // landing whatever the batch still holds for the space, so a staged put or tombstone for the
    // same path can never land after the direct write and undo it. A direct channel never stages
    // anything, so it neither waits for the batch nor opens one.
    const interactive = item.priority === PRIORITY.INTERACTIVE
    if (interactive && !channel.direct) await settleCatalog(item.spaceId)
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
      result = await channel.publish(item, ctx, { catalog, signal: item.signal, deep: item.deep })
    } catch (err) {
      await channel.onPublishFailed?.(item, ctx, err)
      throw err
    }
    await channel.afterPublish?.(item, ctx, result)
    return { outcome: result?.changed ? 'published' : 'unchanged' }
  }
}
