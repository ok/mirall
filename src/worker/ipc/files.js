// @ts-check
// The loose-file surface: what a space holds, what is being sent, and the download controls.
// "Loose" files live in the space itself rather than in a shared folder; their downloads run on the
// one download engine as the loose share of their owner.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { Logger } from '../../shared/core/logger.js' */
import { getSpace } from '../../shared/spaces/space.js'
import { errorMessage } from '../../shared/core/errors.js'
import { isSpaceLeaving } from '../../shared/network/leave-protocol.js'
import { listFiles, removeFile, addFile } from '../../shared/transfer/file-listing.js'
import { emptyListing } from '../../shared/transfer/listing-envelope.js'
import { revealFile } from '../../shared/transfer/reveal.js'
import { overlayBackend } from '../../shared/transfer/overlay/index.js'
import { cancelShareDownload, looseShareOfOwner, pauseShareDownload } from '../../shared/transfer/overlay/share-downloads.js'
import { looseCancelPublish, handleLooseFsEvent } from '../../shared/transfer/overlay/loose-publish.js'
import { LOOSE_SHARE_ID, looseRelPath, transferIdParts } from '../../shared/transfer/transfer-id.js'
import { subscribeServeDetail, unsubscribeServeDetail, dropServeDetailClient, listServeSummaries } from '../../shared/transfer/serve-ledger.js'
import { listFileRecipients } from '../../shared/transfer/file-recipients.js'
import { rescueStalledTransfers } from '../../shared/network/convergence-tick.js'
import { record } from '../../shared/audit/audit-log.js'
import { selfActor, targetRef } from '../../shared/audit/audit-record.js'
import { TARGET_KIND } from '../../shared/contract/audit-kinds.js'
import { spaceRefOf, fileNameOf } from '../audit-refs.js'
import { assertCatalogWritable } from '../../shared/core/restore-guard.js'

/** @param {WorkerIpc} ipc @param {{ log: Logger }} deps */
export function registerFiles(ipc, { log }) {
  ipc.handle('event:loose-file-fs-event', async (msg) => {
    try {
      await handleLooseFsEvent({ spaceId: msg.spaceId, absPath: msg.absPath, action: msg.action })
    } catch (err) {
      log.warn('loose-file fs event failed:', errorMessage(err))
    }
    return { ok: true }
  })

  // Sender-side download indicator: open/close a per-file detail subscription so the
  // worker only streams per-peer progress for a file whose row is expanded. Subscribe
  // returns the current snapshot so the dropdown renders immediately; the ledger sweep
  // pushes the authoritative snapshot while subscribed (no renderer poll).
  ipc.handle('serving:summary-list', async (msg) => listServeSummaries(msg.spaceId))
  ipc.handle('serving:detail-subscribe', async (msg, ctx) => subscribeServeDetail(msg.spaceId, msg.path, ctx.client.id))
  ipc.handle('serving:detail-unsubscribe', async (msg, ctx) => {
    unsubscribeServeDetail(msg.spaceId, msg.path, ctx.client.id)
    return { ok: true }
  })
  // Registered here rather than in the ledger's own open(): the ledger takes a bare { emit } in two
  // integration files, and the handler layer is where the real router always is.
  ipc.onClientDisconnect((client) => dropServeDetailClient(client.id))

  ipc.handle('recipients:list', async (msg) => (isSpaceLeaving(msg.spaceId) ? [] : listFileRecipients(msg.spaceId)))

  ipc.handle('files:list', async (msg) => {
    if (isSpaceLeaving(msg.spaceId)) return emptyListing() // teardown is purging the catalog — don't race it
    const space = await getSpace(msg.spaceId)
    return await listFiles(msg.spaceId, space?.members || [], { space })
  })
  ipc.handle('files:remove', async (msg) => {
    await assertCatalogWritable(msg.spaceId)
    await removeFile(msg.spaceId, msg.path)
    record('file.unshared', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.FILE, msg.path, fileNameOf(msg.path)),
    })
    // An own file's unshare announces itself; forgetting a peer's file's download record does not,
    // and its row changes all the same.
    ipc.emit('event:share-files-updated', { spaceId: msg.spaceId, shareId: LOOSE_SHARE_ID })
    return { ok: true }
  })
  ipc.handle('files:reveal', async (msg) => {
    await revealFile(msg.spaceId, msg.path)
    return { ok: true }
  })
  ipc.handle('files:add', async (msg) => {
    await assertCatalogWritable(msg.spaceId)
    log.info('adding file:', msg.fileName, 'from', msg.filePath)
    const added = await addFile(msg.spaceId, msg.filePath, msg.fileName)
    // A file cancelled before it finished was never shared.
    if (added?.outcome !== 'cancelled') {
      record('file.shared', {
        actor: selfActor(),
        space: spaceRefOf(await getSpace(msg.spaceId)),
        target: targetRef(TARGET_KIND.FILE, msg.fileName, msg.fileName),
        subject: { size: msg.fileSize ?? null },
      })
    }
    // The publish announces an advertise and a changed or failed publish, not an unchanged re-add
    // or a cancel while queued; the add ends on one poke whichever it was.
    ipc.emit('event:share-files-updated', { spaceId: msg.spaceId, shareId: LOOSE_SHARE_ID })
    return { ok: true }
  })
  ipc.handle('files:download', async (msg) => {
    const { share } = await looseShareOfOwner(msg.spaceId, msg.ownerKey)
    const res = await overlayBackend.requestDownload(msg.spaceId, share, looseRelPath(msg.path))
    // Only a folder share is refused as mirrored or answered as already owned; a loose one never is.
    if ('ok' in res) throw new Error('files:download: a loose download was answered as a folder share')
    // Couldn't start: the owner may simply be unreachable on the bulk plane. Don't make the user
    // wait for the next tick to find that out — the rescue throttles itself, so clicks stay cheap.
    if ('queued' in res) rescueStalledTransfers().catch((err) => log.debug('stalled-transfer rescue failed:', errorMessage(err)))
    return res
  })
  ipc.handle('files:cancel-download', async (msg) => {
    const id = msg.transferId
    // One verb for "stop it and drop the partial", from a downloading row's Cancel and a paused or
    // failed row's Discard alike. A settled row is resolved from its pending row, and a row with
    // nothing left to stop is stale, so its own listing re-derives it.
    const found = await cancelShareDownload(id)
    const parts = transferIdParts(id)
    if (!found && parts) ipc.emit('event:share-files-updated', { spaceId: parts.spaceId, shareId: parts.shareId })
    return { ok: true }
  })
  ipc.handle('files:pause-download', async (msg) => {
    const id = msg.transferId
    // Not gated on a live transfer: a dropped connection can settle the fetch a moment before the
    // click lands, and gating on has() would silently pause nothing — leaving the row to auto-resume
    // on the next reconnect against the user's intent. The engine records the intent either way.
    pauseShareDownload(id)
    return { ok: true }
  })
  ipc.handle('files:cancel-publish', async (msg) => {
    await assertCatalogWritable(msg.spaceId)
    await looseCancelPublish(msg.spaceId, msg.path)
    return { ok: true }
  })
}
