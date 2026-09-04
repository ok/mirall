import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { runMaterializeTick, setForeignEnabled, unmountForeignFolder } from '../../src/shared/folders/foreign-folders.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

// REGRESSION (FIX-128): pausing/unmounting a mirror must abort the file the
// overlay catalog path is fetching right now, not just stop launching the next
// one. Previously stopForeignLoop only tore down the eager Hyperdrive stream and
// bumped the generation (checked between files), so the in-flight overlay
// fetchFile ran to completion. Deterministic + network-free: the overlay's
// fetchFile is stubbed to hang until cancelFetch rejects it with ECANCELLED.

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil (pred, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await delay(20)
  }
  throw new Error('condition not met within ' + ms + 'ms')
}

async function setupOverlayMirror (t, { relPath = 'big.bin', contentHash = 'a'.repeat(64), size = 96 * 1024 * 1024 } = {}) {
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

  // Bypass the real catalog: the materialize tick sees exactly one overlay entry.
  const origListPeer = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => ({ entries: [{ relPath, contentHash, size }], complete: true })
  t.teardown(() => { overlayBackend.listPeerWithMeta = origListPeer })

  // Stub the overlay: fetchFile hangs until cancelFetch rejects it (the real
  // ECANCELLED path), so the fetch is genuinely in-flight when we pause.
  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  const origCancel = overlay.cancelFetch
  t.teardown(() => { overlay.fetchFile = origFetch; overlay.cancelFetch = origCancel })
  const spy = { startedHash: null, rejectFetch: null, cancel: null }
  overlay.fetchFile = (hash) => { spy.startedHash = hash; return new Promise((_res, rej) => { spy.rejectFetch = rej }) }
  overlay.cancelFetch = (hash, opts) => {
    spy.cancel = { hash, opts }
    const err = new Error('cancelled'); err.code = 'ECANCELLED'
    spy.rejectFetch?.(err)
    return true
  }

  await createForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: ctx.tmpDir('mirror'),
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  return { spaceId, shareId, contentHash, spy }
}

test('FIX-128: pausing a mirror cancels the in-flight overlay fetch and keeps the partial', async (t) => {
  const { spaceId, shareId, contentHash, spy } = await setupOverlayMirror(t)

  const tickP = runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.startedHash === contentHash)
  t.is(spy.startedHash, contentHash, 'mirror started fetching the file')
  t.absent(spy.cancel, 'fetch not cancelled before the pause')

  await setForeignEnabled(spaceId, shareId, false)
  t.is(spy.cancel?.hash, contentHash, 'pause cancelled the in-flight fetch by content hash')
  t.is(spy.cancel?.opts?.discardPartial, false, 'pause keeps the partial for resume')

  await tickP
  const mount = await getForeignMount(spaceId, shareId)
  t.absent(mount.enabled, 'mount is disabled (paused), not resurrected by the trailing tick')
})

test('FIX-128: unmounting a mirror cancels the in-flight overlay fetch and discards the partial', async (t) => {
  const { spaceId, shareId, contentHash, spy } = await setupOverlayMirror(t)

  const tickP = runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.startedHash === contentHash)

  await unmountForeignFolder(spaceId, shareId)
  t.is(spy.cancel?.hash, contentHash, 'unmount cancelled the in-flight fetch by content hash')
  t.is(spy.cancel?.opts?.discardPartial, true, 'unmount discards the partial')

  await tickP
  t.is(await getForeignMount(spaceId, shareId), null, 'mount removed by unmount')
})
