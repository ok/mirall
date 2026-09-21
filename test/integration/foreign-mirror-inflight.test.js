import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { stopForeignLoop } from '../../src/shared/folders/foreign-verbs.js'
import { runMaterializeTick, initialMaterializeScan } from '../../src/shared/folders/mirror-pass.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { waitFor } from '../helpers/bare-poll.js'

// runMaterializeTick serialises passes per mount through one in-flight map. Whoever cleans that
// entry up must check it still owns it: initialMaterializeScan registers unconditionally, so the
// entry a tick's cleanup sees is not always the tick's own.

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const waitUntil = (pred, ms = 5000) => waitFor(pred, ms, { interval: 20 })

async function hangingMirror(t) {
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
  overlayBackend.listPeerWithMeta = async () => ({
    entries: [{ relPath: 'big.bin', contentHash: 'a'.repeat(64), size: 96 * 1024 * 1024 }], complete: true,
  })
  t.teardown(() => { overlayBackend.listPeerWithMeta = origListPeer })

  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  const origCancel = overlay.cancelFetch
  t.teardown(() => { overlay.fetchFile = origFetch; overlay.cancelFetch = origCancel })
  const spy = { fetches: 0, rejecters: [] }
  overlay.fetchFile = () => {
    spy.fetches += 1
    return new Promise((_res, rej) => { spy.rejecters.push(rej) })
  }
  overlay.cancelFetch = () => true

  await createForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: ctx.tmpDir('mirror'),
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  t.teardown(() => { stopForeignLoop(spaceId, shareId, { discardPartial: true }) })
  t.teardown(async () => {
    for (const reject of spy.rejecters.splice(0)) {
      const err = new Error('cancelled'); err.code = 'ECANCELLED'
      reject(err)
    }
    await delay(50)
  })
  return { spaceId, shareId, spy }
}

// REGRESSION (FIX-R09-2): the tick's cleanup deleted the in-flight entry unconditionally, unlike
// initialMaterializeScan's, which is identity-guarded. Once a scan owned the entry, the older tick
// settling evicted the LIVE one — and the next tick then started a second pass over the same mount,
// which is the overlapping-snapshot corruption the map exists to prevent. A scan asked for while a
// tick runs now waits for it, so the tick settles while the scan owns the entry.
test('REGRESSION (FIX-R09-2: a settling pass must not evict an in-flight entry it no longer owns)', async (t) => {
  const { spaceId, shareId, spy } = await hangingMirror(t)

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)

  const mount = await getForeignMount(spaceId, shareId)
  initialMaterializeScan(mount)
  await delay(80)
  t.is(spy.fetches, 1, 'the scan waits for the tick instead of walking beside it')

  // Settle the tick. Its cleanup now sees the scan's entry, not its own, and the scan starts.
  const cancelled = new Error('cancelled'); cancelled.code = 'ECANCELLED'
  spy.rejecters.shift()(cancelled)
  await waitUntil(() => spy.fetches === 2, 8000)

  runMaterializeTick(spaceId, shareId)
  await delay(80)
  t.is(spy.fetches, 2, 'the scan is still registered, so the tick coalesces instead of racing it')
})
