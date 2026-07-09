import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import { freshPeer } from '../helpers/store.js'
import { getStore } from '../../src/shared/core/store.js'
import { createSpace, updateMembers } from '../../src/shared/spaces/space.js'
import { classifyLeftovers, purgeLeftovers } from '../../src/shared/storage/leftover.js'

async function coreInStore (dkHex) {
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

// FIX-4 — the orphan-drive reclamation must never touch a current member's
// replicated drive, even when that drive is NOT warmed in memory (getPeerDrive
// returns nothing). Its metadata core is whitelisted by the deterministic member
// driveKey; its blobs core, encountered naked, must be left intact because it is
// reachable only through the kept metadata, never as an orphan.
test('REGRESSION (FIX-4): an un-cached current member’s peer drive is never reclaimed', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')

  const peer = new Hyperdrive(getStore().namespace('peer-sim'))
  await peer.ready()
  await peer.put('/photo.bin', Buffer.from('replicated peer content that must survive'))
  const peerKey = b4a.toString(peer.core.key, 'hex')
  const metaDk = b4a.toString(peer.core.discoveryKey, 'hex')
  const blobs = await peer.getBlobs()
  const blobsDk = b4a.toString(blobs.core.discoveryKey, 'hex')
  await peer.close() // a replicated peer drive is not necessarily warmed in memory

  await updateMembers(space.spaceId, [{ publicKey: 'peerPubKey', driveKey: peerKey, displayName: 'Peer' }])

  t.ok(await coreInStore(metaDk), 'precondition: peer meta present')
  t.ok(await coreInStore(blobsDk), 'precondition: peer blobs present')

  const scan = await classifyLeftovers()
  const flagged = scan.orphanDrives.keys.some((d) => d.metaDkHex === metaDk || d.blobsDkHex === blobsDk)
  t.absent(flagged, 'the member drive is not flagged as an orphan')

  await purgeLeftovers() // all purgeable categories, including orphanDrives

  t.ok(await coreInStore(metaDk), 'member peer drive meta preserved')
  t.ok(await coreInStore(blobsDk), 'member peer drive blobs preserved')
})
