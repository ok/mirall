import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

// End-to-end: the durable mirror-participation record lets a share's OWNER see who mirrors it,
// and its state, across the wire — a fact the ephemeral serve ledger can't carry once bytes stop.
test('owner sees a peer mount, pause and unmount a mirror of its share', { timeout: 90000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Photos' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'pic.bin'), patternedBytes(20 * 1024, 11))
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (list) => list.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })

  const bState = (rows) => (Array.isArray(rows) ? rows.find((r) => r.mirrorer === bKey)?.state : undefined)
  // The mount publishes 'syncing'; once the (small) folder fully materializes the mirrorer flips
  // its own record to 'synced' — the authoritative sync-state the owner observes.
  await A.until('space:mirrors', { spaceId, shareId: share.id }, (rows) => bState(rows) === 'synced', { ms: 30000 })

  await B.request('foreign-folder:set-enabled', { spaceId, shareId: share.id, enabled: false })
  await A.until('space:mirrors', { spaceId, shareId: share.id }, (rows) => bState(rows) === 'paused', { ms: 30000 })

  await B.request('foreign-folder:unmount', { spaceId, shareId: share.id })
  await A.until('space:mirrors', { spaceId, shareId: share.id }, (rows) => !rows.some((r) => r.mirrorer === bKey), { ms: 30000 })

  const finalRows = await A.request('space:mirrors', { spaceId, shareId: share.id })
  t.absent(finalRows.some((r) => r.mirrorer === bKey), 'owner no longer lists the unmounted mirror')

  A.kill()
})

// The durable half's whole point: an owner OFFLINE when the mirror is dropped still learns of it —
// the tombstone replicates on reconnect. The ephemeral serve ledger cannot do this.
test('a peer unmount reaches an owner who was offline at unmount time', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aStore = mkTmpDir(t)
  let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Photos' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'pic.bin'), patternedBytes(20 * 1024, 11))
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (list) => list.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await A.until('space:mirrors', { spaceId, shareId: share.id },
    (rows) => rows.some((r) => r.mirrorer === bKey && r.state === 'synced'), { ms: 30000 })

  // Owner offline; peer drops the mirror while the owner can't see it live.
  A.kill()
  await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 60000 })
  await B.request('foreign-folder:unmount', { spaceId, shareId: share.id })

  // Owner returns; the durable tombstone replicates and the mirror drops out of the listing.
  A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
  await A.until('space:mirrors', { spaceId, shareId: share.id },
    (rows) => !rows.some((r) => r.mirrorer === bKey), { ms: 60000 })
  t.pass('offline-at-unmount owner learns the mirror stopped on reconnect')

  A.kill()
})
