import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { runMaterializeTick } from '../../src/shared/folders/foreign-folders.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

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

  await saveForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: ctx.tmpDir('mirror'),
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  return { ctx, spaceId, shareId }
}

test('REGRESSION (FIX-129): an ENOSPC overlay-mirror fetch pauses the mount (paused-enospc)', async (t) => {
  const { ctx, spaceId, shareId } = await setupOverlayMirror(t, 'ENOSPC')
  await runMaterializeTick(spaceId, shareId)
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-enospc', 'mount paused with the enospc status')
  t.absent(mount.enabled, 'mount disabled')
  t.ok(statuses(ctx, shareId).includes('paused-enospc'), 'paused-enospc status surfaced')
})

test('REGRESSION (FIX-129): an EACCES overlay-mirror fetch pauses the mount (paused-error)', async (t) => {
  const { spaceId, shareId } = await setupOverlayMirror(t, 'EACCES')
  await runMaterializeTick(spaceId, shareId)
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-error', 'mount paused with the generic error status')
  t.absent(mount.enabled, 'mount disabled')
})
