import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createSpace, getSpace, upsertMember, removeMember } from '../../src/shared/spaces/space.js'

// REGRESSION: concurrent member writes used to be a read-modify-write race —
// each handshake did getSpace()→push→updateMembers(whole list), so two landing
// at once (a peer joining a space that already has 2+ members) clobbered each
// other and a co-member (typically the owner) was silently dropped. upsertMember
// now serializes per space and re-reads inside the write, so no update is lost.
test('concurrent upsertMember calls never lose a member', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')

  const keys = Array.from({ length: 12 }, (_, i) => 'pk' + i.toString().padStart(2, '0') + 'a'.repeat(58))
  // Fire every add at once — the exact concurrency that lost updates before.
  await Promise.all(keys.map((pk, i) =>
    upsertMember(space.spaceId, { publicKey: pk, driveKey: 'dk' + i, displayName: 'Peer ' + i })))

  const got = await getSpace(space.spaceId)
  const present = new Set((got.members || []).map((m) => m.publicKey))
  for (const pk of keys) t.ok(present.has(pk), 'member ' + pk.slice(0, 6) + ' persisted')
  t.is(got.members.length, keys.length, 'no duplicates, none dropped')
})

test('upsertMember merges fields without clobbering and never duplicates', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const pk = 'pk' + 'f'.repeat(62)

  await upsertMember(space.spaceId, { publicKey: pk, driveKey: 'dk', displayName: 'Carol' })
  // A concurrent rename and avatar-fetch landing together must both stick.
  await Promise.all([
    upsertMember(space.spaceId, { publicKey: pk, displayName: 'Carol R.' }),
    upsertMember(space.spaceId, { publicKey: pk, avatar: 'data:img' }),
  ])

  const m = (await getSpace(space.spaceId)).members.filter((x) => x.publicKey === pk)
  t.is(m.length, 1, 'still a single entry')
  t.is(m[0].displayName, 'Carol R.', 'rename applied')
  t.is(m[0].avatar, 'data:img', 'avatar applied, not clobbered by the rename')
  t.is(m[0].driveKey, 'dk', 'original driveKey preserved (null patch never overwrites)')
})

test('upsertMember with create:false will not resurrect a removed member', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const pk = 'pk' + '9'.repeat(62)

  await upsertMember(space.spaceId, { publicKey: pk, driveKey: 'dk', displayName: 'Bob' })
  // A late avatar fetch racing a removal must not re-add the member.
  await Promise.all([
    removeMember(space.spaceId, pk),
    upsertMember(space.spaceId, { publicKey: pk, avatar: 'data:img' }, { create: false }),
  ])

  const present = (await getSpace(space.spaceId)).members.some((m) => m.publicKey === pk)
  t.absent(present, 'removed member stays gone')
})
