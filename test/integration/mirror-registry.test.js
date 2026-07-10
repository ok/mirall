import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createSpace, updateMembers } from '../../src/shared/spaces/space.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createBee } from '../../src/shared/core/store.js'
import { publishMirror } from '../../src/shared/folders/mirror-records.js'
import { listMirrorsForShare, listMirrorsForSpace } from '../../src/shared/folders/mirror-registry.js'

let seq = 0
async function memberMirrorBee (spaceId, shareId, state, { tombstoned = false } = {}) {
  const bee = createBee('peer-' + (seq++))
  await bee.ready()
  await bee.put('caps/folder-mirrors', true)
  const rec = { shareId, spaceId, state, mountedAt: Date.now(), ts: Date.now() }
  if (tombstoned) rec.unmirroredAt = Date.now()
  await bee.put('mirror/' + spaceId + '/' + shareId, rec)
  const key = b4a.toString(bee.core.key, 'hex')
  await bee.close()
  return key
}

test('listMirrorsForSpace merges own + members, tagged by mirrorer', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const me = getLocalPublicKeyHex()
  await publishMirror(spaceId, 'shareX', { state: 'synced' })

  const peerKey = await memberMirrorBee(spaceId, 'shareX', 'paused')
  await updateMembers(spaceId, [{ publicKey: peerKey, driveKey: null, displayName: 'Peer' }])

  const all = await listMirrorsForSpace(spaceId)
  const byMirrorer = new Map(all.map((m) => [m.mirrorer, m]))
  t.is(all.length, 2, 'own + one member')
  t.is(byMirrorer.get(me).state, 'synced', 'own record tagged mirrorer=me')
  t.is(byMirrorer.get(peerKey).state, 'paused', 'member record tagged with their key')

  const forShare = await listMirrorsForShare(spaceId, 'shareX')
  t.is(forShare.length, 2, 'both mirror the same share')
  t.alike(await listMirrorsForShare(spaceId, 'other'), [], 'a share nobody mirrors → empty')
})

test('a non-member mirror record is never folded in (trust boundary)', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  await memberMirrorBee(spaceId, 'shareX', 'synced') // authored but NOT added to members
  t.alike(await listMirrorsForShare(spaceId, 'shareX'), [], 'stranger not in space.members → excluded')
})

test('a member who stopped mirroring (tombstone) drops out of the listing', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const key = await memberMirrorBee(spaceId, 'shareX', 'synced', { tombstoned: true })
  await updateMembers(spaceId, [{ publicKey: key, driveKey: null, displayName: 'Peer' }])
  t.alike(await listMirrorsForShare(spaceId, 'shareX'), [], 'tombstoned member mirror excluded')
})

test('listMirrorsForSpace returns [] for an unknown space', async (t) => {
  await freshPeer(t)
  t.alike(await listMirrorsForSpace('does-not-exist'), [], 'unknown space → empty')
})
