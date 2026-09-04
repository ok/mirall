import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { runMaterializeTick, recordMirrorScanFault, setForeignEnabled } from '../../src/shared/folders/foreign-folders.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'
import fs from 'bare-fs'

// REGRESSION (FIX-129): a disk-write failure during an overlay mirror fetch must
// pause the mount with a surfaced status — same classification as the eager path —
// instead of being logged as a generic give-up that retries every poll tick.
// Network-free: the overlay's fetchFile is stubbed to throw the fs error code that
// (post-fix) now propagates out of the real fetch.

function statuses (ctx, shareId) {
  return ctx.fake.events
    .filter((e) => e.type === 'event:foreign-folder-mount-status' && e.payload?.shareId === shareId)
    .map((e) => e.payload.status)
}

function faultEvents (ctx, shareId) {
  return ctx.fake.events
    .filter((e) => e.type === 'event:foreign-folder-mount-status' && e.payload?.shareId === shareId)
    .map((e) => e.payload)
}

async function setupOverlayMirror (t, code) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })

  const space = await createSpace('Aurora')
  const spaceId = space.spaceId
  const shareId = generateShareId()
  await publishShare(spaceId, {
    id: shareId, type: 'owned-folder', name: 'Mirror', owner: getLocalPublicKeyHex(),
    contentMode: 'overlay', catalogKey: 'c'.repeat(64), createdAt: Date.now(),
  })

  const origListPeer = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => ({ entries: [{ relPath: 'big.bin', contentHash: 'a'.repeat(64), size: 1024 }], complete: true })
  t.teardown(() => { overlayBackend.listPeerWithMeta = origListPeer })

  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  t.teardown(() => { overlay.fetchFile = origFetch })
  overlay.fetchFile = async () => { const e = new Error('disk error'); e.code = code; throw e }

  const mountPath = ctx.tmpDir('mirror')
  await createForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath,
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  return { ctx, spaceId, shareId, mountPath }
}

test('REGRESSION (FIX-129): an ENOSPC overlay-mirror fetch pauses the mount (paused-enospc)', async (t) => {
  const { ctx, spaceId, shareId } = await setupOverlayMirror(t, 'ENOSPC')
  await runMaterializeTick(spaceId, shareId)
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-enospc', 'mount paused with the enospc status')
  t.absent(mount.enabled, 'mount disabled')
  t.ok(statuses(ctx, shareId).includes('paused-enospc'), 'paused-enospc status surfaced')
})

// REGRESSION (FIX-MIRROR-PAUSE-RENAMES: a pause is the ONLY chance to persist the conflict mapping a
// pass minted. resolveLocalRelPath records the sibling by mutating the pass-held mount object in
// memory, and stopForeignLoop bumps the generation immediately after this write — after which
// state.persist declines. Deriving the sync fields from the record read inside the lock instead of
// from that object wrote the mapping the pass STARTED with, stranding the sibling on disk with
// nothing pointing at it, so the next pass minted 'big (2).bin' beside it.)
test('REGRESSION (FIX-MIRROR-PAUSE-RENAMES): a pause persists the conflict mapping the pass minted', async (t) => {
  const { spaceId, shareId, mountPath } = await setupOverlayMirror(t, 'ENOSPC')
  // The user's own file at the natural name, so the pass has to mint a sibling before it fetches.
  fs.writeFileSync(mountPath + '/big.bin', 'the users own file')

  await runMaterializeTick(spaceId, shareId)

  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-enospc', 'the pass paused on the disk fault')
  t.ok(mount.renamedPaths?.['big.bin'], 'and the durable record carries the sibling it had already minted')
  t.not(mount.renamedPaths['big.bin'], 'big.bin', 'which is a sibling, not the natural name')
})

test('REGRESSION (FIX-129): an EACCES overlay-mirror fetch pauses the mount (paused-error)', async (t) => {
  const { spaceId, shareId } = await setupOverlayMirror(t, 'EACCES')
  await runMaterializeTick(spaceId, shareId)
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-error', 'mount paused with the generic error status')
  t.absent(mount.enabled, 'mount disabled')
})

// A pause carries a REASON the renderer can translate. It used to carry err.message, which reached
// the user as "ENOSPC: no space left on device, write '/Users/…'" in every language.
test('a pause records the error code, never the errno message', async (t) => {
  const { spaceId, shareId } = await setupOverlayMirror(t, 'ENOSPC')
  await runMaterializeTick(spaceId, shareId)
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.lastError, ErrorCodes.TRANSFER_DISK_FULL, 'durable, so the folder screen survives a reload')
})

// The mount-time scan is the one producer that is not a pause: its loop still starts, so it must
// record the fault WITHOUT disabling the mount, and it must not put a raw message on a wire field
// the renderer reads as a code.
test('a failed initial scan records the fault without pausing the mount', async (t) => {
  const { ctx, spaceId, shareId } = await setupOverlayMirror(t, 'EACCES')
  const err = Object.assign(new Error("EACCES: permission denied, open '/Volumes/ext/x'"), { code: 'EACCES' })

  const status = await recordMirrorScanFault(spaceId, shareId, err)

  t.is(status, 'paused-error')
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-error', 'durable — a reload used to show a mirror still "scanning"')
  t.is(mount.lastError, ErrorCodes.TRANSFER_PERMISSION)
  t.ok(mount.enabled, 'the poll loop still runs, so this is not an auto-pause')
  const last = faultEvents(ctx, shareId).at(-1)
  t.is(last.error, ErrorCodes.TRANSFER_PERMISSION, 'the wire carries the code the renderer translates')
})

test('a successful pass clears the reason with the status', async (t) => {
  const { spaceId, shareId } = await setupOverlayMirror(t, 'ENOSPC')
  await runMaterializeTick(spaceId, shareId)
  t.is((await getForeignMount(spaceId, shareId)).lastError, ErrorCodes.TRANSFER_DISK_FULL, 'precondition')

  const overlay = getOverlay()
  overlay.fetchFile = async (hash, { destPath } = {}) => { fs.writeFileSync(destPath, 'ok'); return { destPath } }
  await setForeignEnabled(spaceId, shareId, true)
  await runMaterializeTick(spaceId, shareId)

  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'active')
  t.is(mount.lastError, null, 'a stale reason would name the next fault that records none')
})
