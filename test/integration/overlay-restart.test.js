import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveOwnedMount } from '../../src/shared/folders/mount-store.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { getOverlay, initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import {
  initContentBackendOverlay, _resetContentBackendOverlay, rehydrateOwnedFiles,
} from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

// init() backgrounds rehydrate (non-blocking boot, C9); drive it deterministically.
const initAndRehydrate = async () => { await initOverlay(); await rehydrateOwnedFiles() }

// R5: the facade serve maps (_contentHashPaths) are NOT persisted — after a
// worker restart owned files stop being servable until re-registered. init()'s
// rehydrate must re-register every owned overlay file whose source still exists.
test('rehydrate restores servability after a restart', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name: 'Vault',
    contentMode: 'overlay',
    owner: getLocalPublicKeyHex(),
    createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  await saveOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  const abs = path.join(mountPath, 'persist.txt')
  fs.writeFileSync(abs, 'persist me across a restart')

  initContentBackendOverlay(ctx.fake.ipc)
  serveIndex._reset()
  await initAndRehydrate()
  t.teardown(async () => { _resetContentBackendOverlay(); serveIndex._reset(); await teardownOverlay() })

  await overlayBackend.publishAdd(space.spaceId, share, 'persist.txt', abs)
  const hash = (await getOwnEntry(space.spaceId, share.id, 'persist.txt')).contentHash
  t.ok(serveIndex.has(hash), 'servable before restart')

  // Simulate a worker restart: close the overlay + drop the in-memory serve maps.
  await teardownOverlay()
  serveIndex._reset()
  t.absent(serveIndex.has(hash), 'serve maps empty after restart (not persisted)')

  // Reboot: init re-creates the instance and rehydrates from the catalog + disk.
  await initAndRehydrate()
  t.ok(serveIndex.has(hash), 'file servable again after rehydrate')

  const got = await getOverlay().fetchFile(hash, {})
  t.ok(got?.local, 'served locally after rehydrate')
  t.is(got.destPath, abs, 're-registered against the real source file')
  t.is(fs.readFileSync(got.destPath).toString(), 'persist me across a restart')
})

test('rehydrate skips entries whose source file is gone', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name: 'Vault',
    contentMode: 'overlay',
    owner: getLocalPublicKeyHex(),
    createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  await saveOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  const abs = path.join(mountPath, 'gone.txt')
  fs.writeFileSync(abs, 'temporary')

  initContentBackendOverlay(ctx.fake.ipc)
  serveIndex._reset()
  await initAndRehydrate()
  t.teardown(async () => { _resetContentBackendOverlay(); serveIndex._reset(); await teardownOverlay() })

  await overlayBackend.publishAdd(space.spaceId, share, 'gone.txt', abs)
  const hash = (await getOwnEntry(space.spaceId, share.id, 'gone.txt')).contentHash

  // Restart, but the source file vanished while the worker was down.
  await teardownOverlay()
  serveIndex._reset()
  fs.unlinkSync(abs)

  await initAndRehydrate() // must not throw on the missing source
  t.absent(serveIndex.has(hash), 'a vanished source is not re-registered')
})
