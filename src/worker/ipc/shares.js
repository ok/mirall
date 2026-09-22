// Folder shares: the record a space advertises, and the read paths over one share's contents.
// Creation is split into a refusal half and a replicating half because the composed
// create-and-mount has to record a durable intent between them.

import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'
import { TARGET_KIND } from '../../shared/contract/audit-kinds.js'
import { isOverlayEnabled } from '../../shared/core/runtime-config.js'
import { getLocalPublicKeyHex } from '../../shared/spaces/profile.js'
import { getSpace, getSpaceContentKey, isLegacySpace, LEGACY_SPACE_MESSAGE } from '../../shared/spaces/space.js'
import { publishShare, tombstoneShare, readOwnShares, isValidShareName, generateShareId } from '../../shared/shares/shares.js'
import { listSharesForSpace } from '../../shared/shares/share-registry.js'
import { consumerFilePath, listOverlayShareFiles } from '../../shared/shares/share-listing.js'
import { catalogKeyField } from '../../shared/shares/catalog-keys.js'
import { ownCatalogPublish } from '../../shared/shares/own-catalog.js'
import { getContentBackend, UNSUPPORTED } from '../../shared/transfer/content-backends.js'
import { revealLocalPath } from '../../shared/transfer/reveal.js'
import { folderCancelByKey } from '../../shared/transfer/backends/overlay/folder-downloads.js'
import { transferIdFor } from '../../shared/transfer/transfer-id.js'
import { pathFromMount } from '../../shared/folders/path-guard.js'
import { isSpaceLeaving } from '../../shared/network/leave-protocol.js'
import { spaceStorageSummary } from '../../shared/storage/space-storage.js'
import { validateMountPath } from '../../shared/folders/mount-validate.js'
import { getOwnedMount, getForeignMount } from '../../shared/folders/mount-store.js'
import { record } from '../../shared/audit/audit-log.js'
import { selfActor, targetRef } from '../../shared/audit/audit-record.js'
import { spaceRefOf } from '../audit-refs.js'

// The share record the space would see, with every refusal already made and nothing written down
// yet. Split from the publish below because the composed create-and-mount has to record a durable
// intent naming this share AFTER the last refusal and BEFORE the first replicated write, and the
// share's id does not exist until here.
async function prepareOwnedShare(spaceId, name) {
  const space = await getSpace(spaceId)
  if (!space) throw new AppError(CODES.SPACE_NOT_FOUND, 'Space not found')
  const trimmed = (name || '').trim()
  if (!isValidShareName(trimmed)) throw new AppError(CODES.SHARE_NAME_INVALID, 'Invalid share name')

  const existingOwn = await readOwnShares(spaceId)
  if (existingOwn.some((s) => s.name === trimmed)) {
    throw new AppError(CODES.SHARE_NAME_COLLISION, 'A folder with this name already exists in this space')
  }

  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name: trimmed,
    owner: getLocalPublicKeyHex(),
    spaceId,
    createdAt: Date.now(),
  }
  // Overlay is the only content backend: serve straight from the source file (no
  // second copy), advertising into a replicated catalog peers list/fetch from.
  // Stamped at creation (replicates). A build without overlay can't create shares.
  if (!isOverlayEnabled()) throw new AppError(CODES.OVERLAY_REQUIRED, 'Folder sharing requires the overlay backend')
  // Before the SCK check below, which would otherwise report a pre-encryption space as one we are
  // merely un-approved for.
  if (isLegacySpace(space)) throw new AppError(CODES.SPACE_UNSUPPORTED, LEGACY_SPACE_MESSAGE)
  // A space's catalog is SCK-encrypted; without the SCK (a pending, not-yet-approved member)
  // we can't open our own catalog to advertise into. Refuse cleanly rather than let ownCatalog
  // throw a raw Error out of the IPC handler.
  if (!getSpaceContentKey(spaceId, space)) {
    throw new AppError(CODES.EOWNERSHIP, 'Cannot share into a space you have not been approved for yet')
  }
  share.contentMode = 'overlay'
  const { keyHex, encrypted } = await ownCatalogPublish(spaceId)
  Object.assign(share, catalogKeyField(keyHex, encrypted))
  return { share, space }
}

// The replicated half: the moment this returns, every co-member's view of our profile bee carries
// the folder.
async function publishOwnedShare(ipc, space, share) {
  await publishShare(space.spaceId, share)
  record('share.created', {
    actor: selfActor(),
    space: spaceRefOf(space),
    target: targetRef(TARGET_KIND.SHARE, share.id, share.name),
  })
  ipc.emit('event:shares-updated', { spaceId: space.spaceId })
}

async function loadShareDescriptor(spaceId, ownerKey, shareId) {
  const all = await listSharesForSpace(spaceId)
  const share = all.find((s) => s.id === shareId && s.owner === ownerKey)
  if (!share) throw new AppError(CODES.SHARE_NOT_FOUND, 'Share not found')
  return share
}

export function registerShares(ipc, { log, intents, mountOwnedShare }) {
  ipc.handle('share:list', async (msg) => {
    return await listSharesForSpace(msg.spaceId)
  })

  ipc.handle('share:create', async (msg) => {
    const { share, space } = await prepareOwnedShare(msg.spaceId, msg.name)
    await publishOwnedShare(ipc, space, share)
    return share
  })

  // The two writes this runs land in different bees, and the FIRST one replicates: publishOwnedShare
  // puts a row into our profile bee that every co-member reads, while the second sits behind a full
  // disk walk that takes seconds to tens of seconds on a large folder. A crash in between leaves a
  // folder advertised to the whole space with no mount behind it — and every owner-side pass skips a
  // mount-less share, so nothing would notice and the user would have no folder to delete. The
  // compensation lives here, not in the renderer: that is the one process that cannot be relied on
  // to still be running when it is needed.
  //
  // Recorded first, cleared last; the next boot finishes whatever this did not.
  ipc.handle('share:create-and-mount', async (msg) => {
    // Both refusal paths run before the intent: a bad path or a name collision is a refusal, not a
    // half-done flow, and an intent recorded for work that never started is an orphan the boot pass
    // would act on. The admission gate (the file-count walk) stays inside the mount, i.e. after the
    // publish — moving it earlier would walk the folder twice, and that walk is the window the intent
    // now covers.
    const validated = await validateMountPath(msg.mountPath, 'owned-folder', { shareId: null })
    const { share, space } = await prepareOwnedShare(msg.spaceId, msg.name)

    const intentId = await intents.beginOrNull('share-create-mount', { spaceId: msg.spaceId, shareId: share.id })
    try {
      await publishOwnedShare(ipc, space, share)
      const result = await mountOwnedShare({ spaceId: msg.spaceId, share, validated, ignore: msg.ignore })
      await intents.complete(intentId)
      return { share, ...result }
    } catch (err) {
      // The live compensation. If THIS fails the intent stays and the next boot completes it. The
      // share.deleted row is what lets the activity log explain a folder that appeared and went away.
      try {
        await tombstoneShare(msg.spaceId, share.id)
        record('share.deleted', {
          actor: selfActor(),
          space: spaceRefOf(space),
          target: targetRef(TARGET_KIND.SHARE, share.id, share.name),
        })
        await intents.complete(intentId)
      } catch (tombstoneErr) {
        // The intent is deliberately left standing: this is exactly the state it exists for.
        log.warn('could not retire a folder whose mount failed — the next boot will:', share.id, '-', tombstoneErr.message)
      }
      ipc.emit('event:shares-updated', { spaceId: msg.spaceId })
      throw err
    }
  })

  // Rename an owned folder — the LABEL, in a field of its own. `share.name` is not a label: it is the
  // first segment of the consumer-side drive path ('/<name>/<relPath>'), which keys every download
  // claim, every pending transfer and every reveal target on every member's machine. Rewriting it
  // would silently orphan all of them — downloaded files would revert to remote, re-downloads would
  // write second copies, and in-flight partials could no longer be cancelled. So the immutable key
  // stays put and `displayName` carries what people read; the renderer resolves one from the other.
  ipc.handle('share:rename', async (msg) => {
    const space = await getSpace(msg.spaceId)
    if (!space) throw new AppError(CODES.SPACE_NOT_FOUND, 'Space not found')
    const displayName = (msg.name || '').trim()
    if (!isValidShareName(displayName)) throw new AppError(CODES.SHARE_NAME_INVALID, 'Invalid share name')

    const own = await readOwnShares(msg.spaceId)
    const share = own.find((s) => s.id === msg.shareId)
    if (!share) throw new AppError(CODES.SHARE_NOT_FOUND, 'Share not found')
    const labelOf = (s) => s.displayName || s.name
    if (labelOf(share) === displayName) return share
    if (own.some((s) => s.id !== msg.shareId && labelOf(s) === displayName)) {
      throw new AppError(CODES.SHARE_NAME_COLLISION, 'A folder with this name already exists in this space')
    }

    const previousName = labelOf(share)
    // Renaming back to the on-disk name drops the override rather than storing a duplicate of it.
    const next = { ...share }
    if (displayName === share.name) delete next.displayName
    else next.displayName = displayName
    await publishShare(msg.spaceId, next)
    record('share.renamed', {
      actor: selfActor(),
      space: spaceRefOf(space),
      target: targetRef(TARGET_KIND.SHARE, msg.shareId, displayName),
      subject: { previousName },
    })
    ipc.emit('event:shares-updated', { spaceId: msg.spaceId })
    return next
  })

  ipc.handle('share:delete', async (msg) => {
    const space = await getSpace(msg.spaceId)
    const share = (await readOwnShares(msg.spaceId)).find((s) => s.id === msg.shareId)
    await tombstoneShare(msg.spaceId, msg.shareId)
    record('share.deleted', {
      actor: selfActor(),
      space: spaceRefOf(space),
      target: targetRef(TARGET_KIND.SHARE, msg.shareId, share?.name ?? null),
    })
    ipc.emit('event:shares-updated', { spaceId: msg.spaceId })
    return { ok: true }
  })

  ipc.handle('share:list-files', async (msg, ctx) => {
    const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
    // Overlay is the only content backend; an unsupported mode renders as unavailable. A
    // pre-encryption space lists empty for the same reason — its catalog cannot be opened, and the
    // renderer already explains why (space.legacyWarning) rather than surfacing a failed read.
    const backend = getContentBackend(share)
    if (backend === UNSUPPORTED) return { entries: [], complete: true, total: 0, totalBytes: 0 }
    if (isLegacySpace(await getSpace(msg.spaceId))) return { entries: [], complete: true, total: 0, totalBytes: 0 }
    // The first handler to honour a cancellation, and the one the renderer's query store actually
    // cancels: a folder listing whose view has been superseded or navigated away from.
    return await listOverlayShareFiles(msg.spaceId, share, backend, undefined, { signal: ctx?.signal ?? null })
  })

  ipc.handle('share:reveal-folder', async (msg) => {
    const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
    const isOwn = share.owner === getLocalPublicKeyHex()
    let target
    if (isOwn) {
      const ownedMount = await getOwnedMount(msg.spaceId, msg.shareId)
      if (!ownedMount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Folder is not mounted on this device')
      target = ownedMount.mountPath
    } else {
      const foreignMount = await getForeignMount(msg.spaceId, msg.shareId)
      if (!foreignMount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mirror not mounted')
      target = foreignMount.mountPath
    }
    revealLocalPath(target, CODES.MOUNT_NOT_ON_DEVICE)
    return { ok: true }
  })

  ipc.handle('share:reveal-file', async (msg) => {
    const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
    const isOwn = share.owner === getLocalPublicKeyHex()
    let target
    if (isOwn) {
      const ownedMount = await getOwnedMount(msg.spaceId, msg.shareId)
      if (!ownedMount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Folder is not mounted on this device')
      target = pathFromMount(ownedMount.mountPath, msg.relPath)
    } else {
      target = await consumerFilePath(msg.spaceId, share, msg.relPath)
    }
    revealLocalPath(target)
    return { ok: true }
  })

  ipc.handle('share:folder-info', async (msg) => {
    const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
    const backend = getContentBackend(share)
    if (backend === UNSUPPORTED) return { fileCount: 0, totalBytes: 0, blobsLength: null }
    // overlay: counts come from the catalog (no drive blobs)
    const isOwn = share.owner === getLocalPublicKeyHex()
    // limit=0 → count + sum the catalog in one pass WITHOUT retaining any rows, so a 150k-file
    // folder (e.g. opened in MirrorFolderModal) can't rebuild the full array here and OOM.
    const { total, totalBytes } = isOwn
      ? await backend.listOwn(msg.spaceId, share.id, 0)
      : await backend.listPeerWithMeta(msg.spaceId, share, 0)
    return { fileCount: total, totalBytes, blobsLength: null }
  })

  // Space-wide storage for the space view's storage widget: one aggregate across
  // every folder share plus the loose files (src/shared/storage/space-storage.js).
  ipc.handle('space:storage-summary', async (msg) => {
    if (isSpaceLeaving(msg.spaceId)) return { totalBytes: 0, onDeviceBytes: 0 } // teardown is closing cores — don't race it
    return await spaceStorageSummary(msg.spaceId)
  })

  ipc.handle('share:read-file', async (msg) => {
    const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
    const isOwn = share.owner === getLocalPublicKeyHex()
    const backend = getContentBackend(share)
    if (backend === UNSUPPORTED) throw new AppError(CODES.SHARE_MODE_UNSUPPORTED, 'Share uses an unsupported content mode')
    // overlay: request the file via the backend (catalog/overlay), not a drive
    if (isOwn) return { ok: true, alreadyOwned: true }
    return await backend.requestDownload(msg.spaceId, share, msg.relPath)
  })

  ipc.handle('share:discard-partial', async (msg) => {
    const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
    const drivePath = '/' + share.name + '/' + msg.relPath
    // Overlay folder downloads run on the shared engine; it clears the partial +
    // pending row and emits the share refresh itself.
    await folderCancelByKey(msg.spaceId, drivePath, transferIdFor(msg.spaceId, msg.shareId, msg.relPath))
    return { ok: true }
  })
}
