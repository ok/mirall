import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import { freshPeer, offlineMemberRegistry } from '../helpers/store.js'
import { createBee } from '../../src/shared/core/store.js'
import { getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { boot } from '../../src/worker/boot.js'

const quiet = { debug () {}, info () {}, warn () {}, error () {} }
import { getStore } from '../../src/shared/core/store.js'
import { createSpace, updateMembers } from '../../src/shared/spaces/space.js'
import { cleanupOrphanedData } from '../../src/shared/storage/storage.js'

async function coreInStore (discoveryKey) {
  const dkHex = b4a.toString(discoveryKey, 'hex')
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

// FIX-2 — cleanupOrphanedData purges every store core not in `knownKeys`, but
// knownKeys was built from LOCAL drives only. A cached/replicated PEER drive
// (another member's content) therefore looked like an orphan and was purged —
// silently wiping all replicated content (and it runs at boot on one bad local
// drive, or on the "clean up storage" button). RED until FIX-2.
test('REGRESSION (FIX-2): cleanup does not purge a member’s peer drive', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')

  // Simulate a peer's drive that has been replicated into our store.
  const peerDrive = new Hyperdrive(getStore().namespace('peer-sim'))
  await peerDrive.ready()
  await peerDrive.put('/photo.bin', Buffer.from('replicated peer content'))
  const peerKey = b4a.toString(peerDrive.core.key, 'hex')
  const metaDk = peerDrive.core.discoveryKey
  const blobs = await peerDrive.getBlobs()
  const blobsDk = blobs.core.discoveryKey
  await peerDrive.close() // cores stay on disk (a replicated peer drive isn't necessarily open)

  // Register it as a member's drive in the space.
  await updateMembers(space.spaceId, [{ publicKey: 'peerPubKey', driveKey: peerKey, displayName: 'Peer' }])

  t.ok(await coreInStore(metaDk), 'precondition: peer meta core present')
  t.ok(await coreInStore(blobsDk), 'precondition: peer blobs core present')

  await cleanupOrphanedData()

  t.ok(await coreInStore(metaDk), 'peer meta core preserved after cleanup')
  t.ok(await coreInStore(blobsDk), 'peer blobs core preserved after cleanup')
})

// The sweep used to run only after a drive-load failure, so on a healthy install nothing ever
// collected a departed peer's metadata. It is unconditional now — and boot is the only trigger
// left, so a regression to the old gate would be silent.
test('boot runs the leftover sweep on a healthy store, not only after a drive-load failure', async (t) => {
  const ctx = await freshPeer(t)
  await createSpace('Aurora')

  const stray = createBee('past-peer-catalog-sim')
  await stray.ready()
  await stray.put('file/share-1/a.txt', { size: 10, mtime: 1 })
  const strayDk = stray.core.discoveryKey
  await stray.close()
  t.ok(await coreInStore(strayDk), 'precondition: the stray catalog is on disk')

  const config = getRuntimeConfig()
  await ctx.root.close()
  const second = await boot(config, {
    ipc: createFakeIpc().ipc, log: quiet, swarm: false,
    masterSecret: ctx.masterSecret, memberRegistry: offlineMemberRegistry,
  })
  t.teardown(() => second.close())

  t.absent(await coreInStore(strayDk), 'the boot sweep collected it with no drive-load failure')
})
