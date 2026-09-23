import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { setupOwnedShare } from '../helpers/owned.js'
import { getStore } from '../../src/shared/core/store.js'
import { getOwnEntry } from '../../src/shared/shares/own-catalog.js'
import { classifyLeftovers, purgeLeftovers } from '../../src/shared/storage/leftover.js'
import { getOverlay, getOverlayLocalDiscoveryKeys } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

async function coreInStore(dkHex) {
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

// REGRESSION (FIX-144: the leftover sweep classified the overlay file-index as purgeable and deleted
// it — stranding every chunk map).
test('overlay file-index is never classified or purged as leftover', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  const abs = path.join(mountPath, 'big.bin')
  fs.writeFileSync(abs, Buffer.alloc(2 * 1024 * 1024, 5))
  await overlayBackend.publishAdd(spaceId, share, 'big.bin', abs)
  const hash = (await getOwnEntry(spaceId, share.id, 'big.bin')).contentHash
  t.ok(await getOverlay()._index.hasChunkMapByHash(hash), 'precondition: chunk map present')

  const fiDk = (await getOverlayLocalDiscoveryKeys())[0]
  t.ok(fiDk && await coreInStore(fiDk), 'precondition: file-index core present + resolved')

  const scan = await classifyLeftovers()
  const leftover = [...scan.profiles.keys, ...scan.catalogs.keys].map((r) => r.discoveryKeyHex)
  t.absent(leftover.includes(fiDk), 'file-index not classified as leftover')

  await purgeLeftovers()
  t.ok(await coreInStore(fiDk), 'file-index core survives a full leftover cleanup')
  t.ok(await getOverlay()._index.hasChunkMapByHash(hash), 'chunk map intact after cleanup')
})
