// A foreign mount whose materialize pass never settles: overlay.fetchFile hangs and cancelFetch is
// inert, so nothing the stop path does can settle it. The test holds every rejecter and settles
// them itself, which is what makes the ordering exact. Shared by the mirror-restart suite (the
// loop's own behaviour) and the supervision suite (the mechanism that drives the restart).
import { freshPeer } from './store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { startForeignLoop, stopForeignLoop } from '../../src/shared/folders/foreign-folders.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

export const delay = (ms) => new Promise((r) => setTimeout(r, ms))

export async function waitUntil (pred, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await delay(20)
  }
  throw new Error('condition not met within ' + ms + 'ms')
}

export function cancelled () {
  const err = new Error('cancelled'); err.code = 'ECANCELLED'
  return err
}

export function settleAll (spy) { for (const reject of spy.rejecters.splice(0)) reject(cancelled()) }

export async function wedgedMirror (t, {
  relPath = 'big.bin', contentHash = 'a'.repeat(64), size = 96 * 1024 * 1024, pollMs = 30_000,
} = {}) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, foreignPollIntervalMs: pollMs })
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
  t.teardown(() => { overlay.fetchFile = origFetch; overlay.cancelFetch = origCancel })
  const spy = { fetches: 0, rejecters: [], opts: [] }
  overlay.fetchFile = (_hash, options) => {
    spy.fetches += 1
    spy.opts.push(options)
    return new Promise((_res, rej) => { spy.rejecters.push(rej) })
  }
  overlay.cancelFetch = () => true

  await createForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: ctx.tmpDir('mirror'),
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  await startForeignLoop({ spaceId, shareId })
  t.teardown(() => { stopForeignLoop(spaceId, shareId, { discardPartial: true }) })
  t.teardown(async () => { settleAll(spy); await delay(50) })
  return { spaceId, shareId, spy }
}
