import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createSpace, updateMembers } from '../../src/shared/spaces/space.js'
import { generateShareId } from '../../src/shared/shares/shares.js'
import { createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { runMaterializeTick } from '../../src/shared/folders/foreign-folders.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// REGRESSION (FIX-4): a foreign mirror whose owner LEFT the space (no longer in space.members) must
// be torn down by the materialize loop — even when the owner's share tombstone never reaches us (the
// owner went offline as it left). The membership signal is the robust backstop the deletedAt path
// can't cover. Guard: while the owner is still a member but its share is momentarily unreadable, the
// mount must be LEFT alone (a transient replication gap is not a departure).
test('REGRESSION (FIX-4): the materialize loop unmounts a mirror once its owner leaves the space', async (t) => {
  const ctx = await freshPeer(t)
  // Shrink the per-peer read budget so the unreadable-owner read resolves fast (no live owner bee).
  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: 300 })

  const { spaceId } = await createSpace('Aurora')
  const ownerKey = b4a.toString(b4a.from('b'.repeat(64), 'hex'), 'hex')
  const shareId = generateShareId()

  // The owner is a member; we hold a foreign mount for its (unreadable — no live bee) share.
  await updateMembers(spaceId, [{ publicKey: ownerKey, driveKey: null, displayName: 'Owner' }])
  await createForeignMount({
    spaceId, shareId, ownerKey, mountPath: ctx.tmpDir('mirror'),
    enabled: true, status: 'active', syncedPaths: [], renamedPaths: {},
  })

  // Owner still a member + share unreadable → transient gap, mount is kept.
  await runMaterializeTick(spaceId, shareId)
  t.ok(await getForeignMount(spaceId, shareId), 'mount kept while the owner is still a member')

  // Owner leaves (dropped from members) → the next tick tears the orphaned mount down.
  await updateMembers(spaceId, [])
  await runMaterializeTick(spaceId, shareId)
  t.absent(await getForeignMount(spaceId, shareId), 'mount removed once the owner left the space')
})
