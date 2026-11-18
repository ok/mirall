// @ts-check
// The app-wide transfer surface: every download and every serve on this device in one list, and the
// two verbs that act on all downloads at once. The rows come from the download engine's own pending
// rows and the serve ledger, never from progress frames: a mirrored folder's fetches share the
// progress channel and are not transfers the user asked for.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { Logger } from '../../shared/core/logger.js' */
/** @import { TransferDownload } from '../../shared/contract/responses.js' */
import { errorMessage } from '../../shared/core/errors.js'
import { FILE_STATUS } from '../../shared/contract/statuses.js'
import { getSpace } from '../../shared/spaces/space.js'
import { getForeignMount } from '../../shared/folders/mount-store.js'
import { isOwnerOnline } from '../../shared/network/presence-leases.js'
import { listSharesForSpace } from '../../shared/shares/share-registry.js'
import { listPending } from '../../shared/transfer/pending-transfers.js'
import { listServing } from '../../shared/transfer/serve-ledger.js'
import { LOOSE_SHARE_ID, transferIdFor } from '../../shared/transfer/transfer-id.js'
import { downloadRowFor, groupTransfers } from '../../shared/transfer/transfer-overview.js'
import { overlayBackend } from '../../shared/transfer/overlay/index.js'
import { downloadChannel, looseShareOfOwner, pauseShareDownload, shareDownloadPhase } from '../../shared/transfer/overlay/share-downloads.js'

/** @typedef {{ spaceId: string, shareId: string, relPath: string, ownerKey: string, download: TransferDownload }} ListedDownload */

// One read per space or folder however many rows name it.
/** @template T @param {(key: string) => Promise<T>} read */
function memo(read) {
  /** @type {Map<string, Promise<T>>} */
  const seen = new Map()
  return (/** @type {string} */ key) => {
    let hit = seen.get(key)
    if (!hit) seen.set(key, (hit = read(key)))
    return hit
  }
}

// A folder this device mirrors keeps itself in sync; a download asked for before the mirror was
// set up is the mirror's from then on. A space that is gone has no rows to show.
/** @returns {Promise<ListedDownload[]>} */
async function listedDownloads() {
  const spaceOf = memo((spaceId) => getSpace(spaceId))
  const mirrored = memo(async (key) => Boolean(await getForeignMount(...(/** @type {[string, string]} */ (key.split('|'))))))
  /** @type {ListedDownload[]} */
  const out = []
  for (const row of await listPending()) {
    if (!downloadChannel.ownsPendingRow(row)) continue
    const { spaceId, shareId, relPath, ownerKey } = row
    if (shareId !== LOOSE_SHARE_ID && await mirrored(spaceId + '|' + shareId)) continue
    const space = await spaceOf(spaceId)
    if (!space) continue
    const owner = (space.members || []).find((/** @type {{ publicKey: string }} */ m) => m.publicKey === ownerKey)
    const download = downloadRowFor(spaceId, row, {
      phase: shareDownloadPhase(transferIdFor(spaceId, shareId, relPath)),
      ownerOnline: isOwnerOnline(ownerKey),
      ownerName: owner?.displayName || '',
    })
    if (download) out.push({ spaceId, shareId, relPath, ownerKey, download })
  }
  return out
}

// The share a paused row is resumed through: the owner's loose share, or the folder as the space
// lists it now. A folder that is gone resumes nothing.
/** @param {ListedDownload} d */
async function shareOf(d) {
  if (d.shareId === LOOSE_SHARE_ID) return (await looseShareOfOwner(d.spaceId, d.ownerKey)).share
  const shares = await listSharesForSpace(d.spaceId)
  return shares.find((s) => s.id === d.shareId && s.owner === d.ownerKey) ?? null
}

// What Pause All reaches: everything that is moving or would start moving by itself. A row the
// owner's absence holds is marked too, so it stays paused when they return.
/** @type {ReadonlySet<string>} */
const PAUSABLE = new Set([FILE_STATUS.DOWNLOADING, FILE_STATUS.WAITING, FILE_STATUS.PAUSED_OFFLINE])

/** @param {WorkerIpc} ipc @param {{ log: Logger }} deps */
export function registerTransfers(ipc, { log }) {
  ipc.handle('transfers:list', async () => groupTransfers({ downloads: await listedDownloads(), serving: listServing() }))

  ipc.handle('transfers:pause-all', async () => {
    let count = 0
    for (const { download } of await listedDownloads()) {
      const { status, transferId } = download.file
      if (!transferId || !PAUSABLE.has(status)) continue
      pauseShareDownload(transferId)
      count++
    }
    return { count }
  })

  // Each row resumes into the folder it was going to, as its own Resume does.
  ipc.handle('transfers:resume-all', async () => {
    let count = 0
    for (const d of await listedDownloads()) {
      if (d.download.file.status !== FILE_STATUS.PAUSED_INTERRUPTED) continue
      try {
        const share = await shareOf(d)
        if (!share) continue
        await overlayBackend.requestDownload(d.spaceId, share, d.relPath)
        count++
      } catch (err) {
        log.warn('resume all: a download did not resume:', errorMessage(err))
      }
    }
    return { count }
  })
}
