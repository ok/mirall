import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { ForeignMirrors, runMaterializeTick, setForeignEnabled, unmountForeignFolder } from '../../src/shared/folders/foreign-folders.js'
import { createLifecycle } from '../../src/shared/core/subsystem.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

// REGRESSION (FIX-MIRROR-STOP): a mirror paused mid-download and then unmounted while online
// left the holder's "who is downloading" row stuck at 'paused'. The pause released the in-flight
// fetch slot (activeOverlayFetches cleared), so the subsequent unmount had no inflight to cancel
// and signalled nothing — the holder only reaped the paused row after the 5-min PAUSED_DROP_MS
// sweep. The fix remembers the paused hash and broadcasts CONTROL_STOPPED (notifyTransferStopped)
// on unmount. Deterministic + network-free: the overlay's fetchFile/cancelFetch/notifyTransferStopped
// are stubbed to record calls.

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

  const origListPeer = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => ({ entries: [{ relPath, contentHash, size }], complete: true })
  t.teardown(() => { overlayBackend.listPeerWithMeta = origListPeer })

  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  const origCancel = overlay.cancelFetch
  const origNotify = overlay.notifyTransferStopped
  t.teardown(() => { overlay.fetchFile = origFetch; overlay.cancelFetch = origCancel; overlay.notifyTransferStopped = origNotify })
  const spy = { startedHash: null, rejectFetch: null, cancel: null, stopped: [] }
  overlay.fetchFile = (hash) => { spy.startedHash = hash; return new Promise((_res, rej) => { spy.rejectFetch = rej }) }
  overlay.cancelFetch = (hash, opts) => {
    spy.cancel = { hash, opts }
    const err = new Error('cancelled'); err.code = 'ECANCELLED'
    spy.rejectFetch?.(err)
    return true
  }
  overlay.notifyTransferStopped = (hash) => { spy.stopped.push(hash); return true }

  await saveForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: ctx.tmpDir('mirror'),
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  return { spaceId, shareId, contentHash, spy }
}

const silentLog = { debug () {}, info () {}, warn () {}, error () {} }

test('FIX-MIRROR-STOP: unmount after pause tells holders we stopped', async (t) => {
  const { spaceId, shareId, contentHash, spy } = await setupOverlayMirror(t)

  const tickP = runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.startedHash === contentHash)

  await setForeignEnabled(spaceId, shareId, false)
  t.is(spy.cancel?.opts?.discardPartial, false, 'pause kept the partial (CONTROL_PAUSED)')
  t.alike(spy.stopped, [], 'no STOP yet — still paused')

  await unmountForeignFolder(spaceId, shareId)
  t.alike(spy.stopped, [contentHash], 'unmount broadcast STOPPED for the paused hash')

  await tickP
  t.is(await getForeignMount(spaceId, shareId), null, 'mount removed')
})

test('FIX-MIRROR-STOP: unmount mid-download stops via cancelFetch, not a second notify', async (t) => {
  const { spaceId, shareId, contentHash, spy } = await setupOverlayMirror(t)

  const tickP = runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.startedHash === contentHash)

  await unmountForeignFolder(spaceId, shareId)
  t.is(spy.cancel?.hash, contentHash, 'in-flight fetch cancelled by content hash')
  t.is(spy.cancel?.opts?.discardPartial, true, 'unmount discards the partial (CONTROL_STOPPED)')
  t.alike(spy.stopped, [], 'no separate notifyTransferStopped — cancelFetch already signalled')

  await tickP
  t.is(await getForeignMount(spaceId, shareId), null, 'mount removed')
})

test('FIX-MIRROR-STOP: unmounting an idle mirror sends no stray STOP', async (t) => {
  const { spaceId, shareId, spy } = await setupOverlayMirror(t)

  await unmountForeignFolder(spaceId, shareId)
  t.alike(spy.stopped, [], 'nothing was in flight or paused — nothing to stop')
  t.absent(spy.cancel, 'no fetch to cancel')
})

test('REGRESSION (FIX-PI7-3: a shutdown leaves no paused hash for the next lifetime)', async (t) => {
  // stopAllForeignLoops pauses rather than unmounts, so a shutdown is the one path that FILLS the
  // marker map — and _close cleared everything except that. A marker surviving it makes the next
  // lifetime broadcast STOPPED for a fetch it never started.
  const { spaceId, shareId, contentHash, spy } = await setupOverlayMirror(t)

  const tickP = runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.startedHash === contentHash)

  await setForeignEnabled(spaceId, shareId, false)
  t.is(spy.cancel?.opts?.discardPartial, false, 'the pause kept the partial and remembered the hash')
  t.alike(spy.stopped, [], 'and told the holder nothing yet')

  const life = createLifecycle({ log: silentLog })
  const mirrors = await life.start(new ForeignMirrors('mirrors-under-test', { ipc: createFakeIpc().ipc }))
  mirrors.log = silentLog
  await life.close()

  await unmountForeignFolder(spaceId, shareId)
  t.alike(spy.stopped, [], 'the closed subsystem took its markers with it — no STOP from a dead lifetime')

  await tickP
})
