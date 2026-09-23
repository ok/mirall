// @ts-check
// The scan previews both mount wizards run before committing, and the cancel that stops one.
// Owned and foreign previews share this module because they share the abort registry: a preview
// is cancelled by id, and the id alone does not say which kind of scan is running behind it.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { HandlerContext } from '../../shared/core/handler-table.js' */
/** @import { CancellationSignal } from '../../shared/core/cancellation.js' */
/** @import { Ack } from '../../shared/contract/responses.js' */
import { DEFAULT_IGNORE } from '../../shared/folders/path-keys.js'
import { previewInitialPublishScan } from '../../shared/folders/owned-preview.js'
import { previewMaterializeScan } from '../../shared/folders/foreign-preview.js'
import { createCancellation } from '../../shared/core/cancellation.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'

/** @param {WorkerIpc} ipc */
export function registerFolderPreview(ipc) {
  // clientId → previewId → cancellation. Nested by owner rather than keyed by id alone: ids are
  // minted by the caller from a sequence that restarts at 1 (`pv-1-<spaceId>`), so across clients
  // they collide by construction. Nesting makes another client's id simply absent — there is no
  // ownership check to remember to write.
  /** @type {Map<number, Map<string, ReturnType<typeof createCancellation>>>} */
  const previews = new Map()

  const cancelled = (/** @type {string} */ why) => new AppError(CODES.PREVIEW_CANCELLED, why)

  // Two request names, one function: the names are the wire contract (contract/requests.js).
  /** @param {{ previewId: string }} msg @param {HandlerContext} ctx @returns {Promise<Ack>} */
  const cancelPreview = async (msg, ctx) => {
    // Still { ok: true } for an unknown id: a cancel races the scan's own completion and the caller
    // fires it without waiting to learn which won. What changed is that an id belonging to another
    // client is now unknown rather than cancellable.
    previews.get(ctx.client.id)?.get(msg.previewId)?.abort(cancelled('cancelled by the caller'))
    return { ok: true }
  }
  ipc.handle('owned-folder:cancel-preview', cancelPreview)
  ipc.handle('foreign-folder:cancel-preview', cancelPreview)

  ipc.onClientDisconnect((client) => {
    const mine = previews.get(client.id)
    if (!mine) return
    for (const token of mine.values()) token.abort(cancelled('client disconnected'))
    previews.delete(client.id)
  })

  // The router's own token, not an ad-hoc { aborted: false }: it carries a reason, it supports
  // onAbort for a read that is blocked rather than looping, and the request's own token already
  // dies with the client. A preview with no id cannot be cancelled by frame and reports no
  // progress, so it takes no slot — but it still ends with its request.
  /**
   * @template T
   * @param {HandlerContext} ctx
   * @param {string | null} previewId
   * @param {(signal: CancellationSignal | null) => Promise<T>} run
   * @returns {Promise<T>}
   */
  const withSignal = async (ctx, previewId, run) => {
    if (!previewId) return await run(ctx.signal)
    const local = createCancellation()
    // Either source ends the scan: an explicit cancel-preview frame, or the request's own token
    // (the client went away, or the deadline swept it).
    const off = ctx.signal?.onAbort((reason) => local.abort(reason))
    let mine = previews.get(ctx.client.id)
    if (!mine) previews.set(ctx.client.id, (mine = new Map()))
    mine.set(previewId, local)
    try {
      return await run(local.signal)
    } finally {
      off?.()
      // Only if it is still OURS. One client may reuse an id — a cancel that raced the scan's
      // completion, then a retry under the same id — and an unconditional delete here would remove
      // the retry's token, leaving its cancel button wired to nothing.
      if (mine.get(previewId) === local) mine.delete(previewId)
      if (mine.size === 0) previews.delete(ctx.client.id)
    }
  }

  ipc.handle('owned-folder:preview', async (msg, ctx) => {
    const ignore = msg.ignore || DEFAULT_IGNORE
    const shareId = msg.shareId && msg.shareId !== 'preview' ? msg.shareId : null
    const previewId = msg.previewId || null
    return await withSignal(ctx, previewId, (signal) =>
      previewInitialPublishScan(msg.spaceId, shareId, msg.mountPath, ignore, {
        signal,
        onProgress: previewId
          ? (p) => ipc.emit('event:owned-folder-preview-progress', { previewId, ...p }, { to: ctx.client })
          : null,
      }))
  })

  ipc.handle('foreign-folder:preview', async (msg, ctx) => {
    const previewId = msg.previewId || null
    return await withSignal(ctx, previewId, (signal) =>
      previewMaterializeScan(msg.spaceId, msg.ownerKey, msg.shareId, msg.mountPath, {
        signal,
        onProgress: previewId
          ? (p) => ipc.emit('event:foreign-folder-preview-progress', { previewId, ...p }, { to: ctx.client })
          : null,
      }))
  })

  /** @internal the ownership tests assert the registry does not leak */
  return { _previewCount: () => previews.size }
}
