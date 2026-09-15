// The loose-file surface: what a space holds, what is being sent, and the download controls.
// "Loose" files live in the space itself rather than in a shared folder, and their transfers run
// on the overlay engine alongside folder content — which is why the download controls route on
// the transfer id's shape.

import { getSpace } from '../../shared/spaces/space.js'
import { isSpaceLeaving } from '../../shared/network/leave-protocol.js'
import { listFiles, removeFile, addFile } from '../../shared/transfer/file-listing.js'
import { revealFile } from '../../shared/transfer/reveal.js'
import {
  looseDownload,
  loosePause,
  looseCancel,
  looseCancelTransfer,
  looseCancelPublish,
  handleLooseFsEvent,
} from '../../shared/transfer/loose-overlay.js'
import { folderPause, folderCancel } from '../../shared/transfer/backends/overlay/folder-downloads.js'
import { isLooseTransferId } from '../../shared/transfer/transfer-id.js'
import { subscribeServeDetail, unsubscribeServeDetail, listServeSummaries } from '../../shared/transfer/serve-ledger.js'
import { rescueStalledTransfers } from '../../shared/network/convergence-tick.js'
import { record } from '../../shared/audit/audit-log.js'
import { selfActor, targetRef } from '../../shared/audit/audit-record.js'
import { TARGET_KIND } from '../../shared/contract/audit-kinds.js'
import { spaceRefOf, fileNameOf } from '../audit-refs.js'

export function registerFiles(ipc, { log }) {
  ipc.handle('event:loose-file-fs-event', async (msg) => {
    try {
      await handleLooseFsEvent(msg)
    } catch (err) {
      log.warn('loose-file fs event failed:', err.message)
    }
  })

  // Sender-side download indicator: open/close a per-file detail subscription so the
  // worker only streams per-peer progress for a file whose row is expanded. Subscribe
  // returns the current snapshot so the dropdown renders immediately; the ledger sweep
  // pushes the authoritative snapshot while subscribed (no renderer poll).
  ipc.handle('serving:summary-list', async (msg) => listServeSummaries(msg.spaceId))
  ipc.handle('serving:detail-subscribe', async (msg) => subscribeServeDetail(msg.spaceId, msg.path))
  ipc.handle('serving:detail-unsubscribe', async (msg) => unsubscribeServeDetail(msg.spaceId, msg.path))

  ipc.handle('files:list', async (msg) => {
    if (isSpaceLeaving(msg.spaceId)) return [] // teardown is closing the drive — don't race it
    const space = await getSpace(msg.spaceId)
    return await listFiles(msg.spaceId, space?.members || [])
  })
  ipc.handle('files:remove', async (msg) => {
    await removeFile(msg.spaceId, msg.path)
    record('file.unshared', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.FILE, msg.path, fileNameOf(msg.path)),
    })
    ipc.emit('event:files-updated', { spaceId: msg.spaceId })
    return { ok: true }
  })
  ipc.handle('files:discard-partial', async (msg) => {
    // Loose downloads run on the overlay engine; it clears the partial + pending row
    // and emits files-updated + the decoration done frame itself.
    await looseCancel(msg.spaceId, msg.path)
    return { ok: true }
  })
  ipc.handle('files:reveal', async (msg) => {
    await revealFile(msg.spaceId, msg.path)
    return { ok: true }
  })
  ipc.handle('files:add', async (msg) => {
    log.info('adding file:', msg.fileName, 'from', msg.filePath)
    await addFile(msg.spaceId, msg.filePath, msg.fileName)
    record('file.shared', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.FILE, msg.fileName, msg.fileName),
      subject: { size: msg.fileSize ?? null },
    })
    ipc.emit('event:files-updated', { spaceId: msg.spaceId })
    return { ok: true }
  })
  ipc.handle('files:download', async (msg) => {
    const space = await getSpace(msg.spaceId)
    const member = (space?.members || []).find((m) => m.publicKey === msg.ownerKey)
    const res = await looseDownload(msg.spaceId, member, msg.path)
    // Couldn't start: the owner may simply be unreachable on the bulk plane. Don't make the user
    // wait for the next tick to find that out — the rescue throttles itself, so clicks stay cheap.
    if (res?.queued) rescueStalledTransfers().catch((err) => log.debug('stalled-transfer rescue failed:', err.message))
    return res
  })
  ipc.handle('files:cancel-download', async (msg) => {
    const id = msg.transferId
    // Route on the id's shape, not on a live transfer — the same rule as files:pause-download below,
    // and here a has() gate would leave the partial and the pending row behind a discard that
    // reported ok.
    if (isLooseTransferId(id)) await looseCancelTransfer(id)
    else await folderCancel(id)
    return { ok: true }
  })
  ipc.handle('files:pause-download', async (msg) => {
    const id = msg.transferId
    // Route on the id's shape, not on a live transfer: a dropped connection can settle the fetch a
    // moment before the click lands, and gating on has() would silently pause nothing — leaving the
    // row to auto-resume on the next reconnect against the user's intent.
    if (isLooseTransferId(id)) loosePause(id)
    else folderPause(id)
    return { ok: true }
  })
  ipc.handle('files:cancel-publish', async (msg) => {
    await looseCancelPublish(msg.spaceId, msg.path)
    return { ok: true }
  })
}
