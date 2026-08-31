import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import Hyperdrive from 'hyperdrive'
import { freshPeer } from '../helpers/store.js'
import { getStore } from '../../src/shared/core/store.js'
import { createSpace, getDrive, listSpaces } from '../../src/shared/spaces/space.js'
import { initDownloads, addFile } from '../../src/shared/transfer/files.js'
import { getProfileBee } from '../../src/shared/spaces/profile.js'
import { classifyLeftovers, purgeLeftovers } from '../../src/shared/storage/leftover.js'

async function coreInStore (dkHex) {
  let found = false
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) found = true
  }
  return found
}

// A drive whose space was left without its cores being purged (e.g. crash
// mid-leave) is an orphan drive: its metadata core's discovery key is not among
// any current drive, so it — and the blobs core its header points at — can be
// reclaimed, while an active space's drive and the system bees are untouched.
//
// KNOWN GAP: the remnant below is an UNENCRYPTED drive — the shape a pre-v1.7.0 (eager-era)
// space left behind. classifyLeftovers identifies a drive by opening its metadata core with no
// encryption key and reading it as a Hyperbee (leftover.js inspectCore), so the SCK-encrypted
// metadata core of a space created since then classifies as 'other' and is never reclaimed.
// Reclaiming those needs the inspector to try each known space's SCK; not covered here.
test('orphan drive remnant is reclaimed; active drives and system bees kept', async (t) => {
  await freshPeer(t)
  await initDownloads()
  const keep = await createSpace('Keep')

  // The remnant: an unencrypted drive with content, in its own namespace, belonging to no space.
  const staleDrive = new Hyperdrive(getStore().namespace('stale-space-drive'))
  await staleDrive.ready()
  await staleDrive.put('/big.bin', Buffer.alloc(64 * 1024, 7))
  const staleMetaDk = b4a.toString(staleDrive.core.discoveryKey, 'hex')
  const staleBlobs = await staleDrive.getBlobs()
  const staleBlobsDk = b4a.toString(staleBlobs.core.discoveryKey, 'hex')
  await staleDrive.close()

  const keepDrive = getDrive(keep.spaceId)
  await keepDrive.ready()
  const keepMetaDk = b4a.toString(keepDrive.core.discoveryKey, 'hex')
  const profileDk = b4a.toString(getProfileBee().core.discoveryKey, 'hex')

  const scan = await classifyLeftovers()
  const found = scan.orphanDrives.keys.find((d) => d.metaDkHex === staleMetaDk)
  t.ok(found, 'the stale drive is detected as an orphan drive')
  t.is(found.blobsDkHex, staleBlobsDk, 'orphan blobs core resolved via the metadata header')

  t.ok(await coreInStore(staleMetaDk), 'precondition: stale meta present')
  t.ok(await coreInStore(staleBlobsDk), 'precondition: stale blobs present')

  const res = await purgeLeftovers({ categories: ['orphanDrives'] })
  t.ok(res.purged >= 2, 'both stale cores purged')

  t.absent(await coreInStore(staleMetaDk), 'stale drive meta reclaimed')
  t.absent(await coreInStore(staleBlobsDk), 'stale drive blobs reclaimed')
  t.ok(await coreInStore(keepMetaDk), 'active space drive preserved')
  t.ok(await coreInStore(profileDk), 'profile bee preserved')
  t.ok((await listSpaces()).some((s) => s.spaceId === keep.spaceId), 'active space registry intact')
})
