import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { listSpaces, getSpace, upsertMember } from '../../src/shared/spaces/space.js'
import { joinSpace, createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { encodeInvite, decodeInvite } from '../../src/shared/contract/invite-envelope.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'

test('re-joining the same invite topic is idempotent (one space, still pending)', async (t) => {
  await freshPeer(t)
  const topic = b4a.toString(b4a.alloc(32, 9), 'hex')
  const a = await joinSpace(topic, 'Project')
  const b = await joinSpace(topic, 'Project (again)')
  t.is(a.spaceId, b.spaceId, 'spaceId derived from the topic')
  t.is((await listSpaces()).filter((s) => s.spaceId === a.spaceId).length, 1, 'not duplicated')
  t.is((await getSpace(a.spaceId)).status, 'pending', 'still pending after the second join')
})

test('joining a space you created returns the existing record (no-op)', async (t) => {
  await freshPeer(t)
  const created = await createSpace('Mine')
  const joined = await joinSpace(created.topic, 'Mine')
  t.is(joined.spaceId, created.spaceId)
})

// A v1 invite names its inviter; the pending record shows them so the space is not empty, but the
// name is the invite's claim, so the entry is flagged unverified and carries no authority until the
// fold or an admitted handshake confirms it.
test('REGRESSION (MIR-44: the invite owner was seeded as a member with authority)', async (t) => {
  await freshPeer(t)
  const topic = b4a.toString(b4a.alloc(32, 7), 'hex')
  const ownerKey = 'b'.repeat(64)

  const decoded = decodeInvite(encodeInvite({ topic, name: 'Aurora', owner: ownerKey, ownerName: 'Alice' }))
  t.is(decoded.owner, ownerKey, 'envelope round-trips the inviter key')
  t.is(decoded.ownerName, 'Alice', 'envelope round-trips the inviter name')

  const space = await joinSpace(decoded.topic, decoded.name, undefined, { owner: decoded.owner, ownerName: decoded.ownerName })
  const stored = await getSpace(space.spaceId)
  t.alike(stored.members, [{ publicKey: ownerKey, displayName: 'Alice', avatar: null, unverified: true }], 'the inviter is seeded unverified')
  t.is(stored.inviteOwner, ownerKey, 'and remembered as the invite\'s inviter')

  t.ok(await upsertMember(space.spaceId, { publicKey: ownerKey, avatar: 'data:image/png;base64,A' }, { create: false }), 'an avatar lands')
  t.ok((await getSpace(space.spaceId)).members[0].unverified, 'a display write does not verify the seed')

  t.ok(await upsertMember(space.spaceId, { publicKey: ownerKey, displayName: 'Alice' }, { verified: true }), 'a verified write reports a change')
  const members = (await getSpace(space.spaceId)).members
  t.is(members.length, 1, 'merged into the seed, not duplicated')
  t.absent('unverified' in members[0], 'the flag is gone, not stored as false')
})

test('REGRESSION (MIR-44: re-pasting an invite adds its owner to a space we belong to)', async (t) => {
  await freshPeer(t)
  const created = await createSpace('Mine')
  const again = await joinSpace(created.topic, 'Mine', undefined, { owner: 'c'.repeat(64), ownerName: 'Mallory' })
  t.is(again.spaceId, created.spaceId)
  const stored = await getSpace(created.spaceId)
  t.alike(stored.members, [], 'the record we already hold gains no member')
  t.absent(stored.inviteOwner, 'nor an inviter')
})

test('an invite naming ourselves seeds no one', async (t) => {
  await freshPeer(t)
  const topic = b4a.toString(b4a.alloc(32, 6), 'hex')
  const space = await joinSpace(topic, 'Echo', undefined, { owner: getLocalPublicKeyHex(), ownerName: 'Me' })
  const stored = await getSpace(space.spaceId)
  t.is(stored.members.length, 0, 'no shell for ourselves')
  t.absent(stored.inviteOwner, 'and no inviter hint')
})

// The space:join handler decodes the invite before joining, so a pasted App link
// (mirall://join/<code>) must resolve to the same space as the bare code — the
// decoder peels the deep link. Mirrors the handler's decodeInvite → joinSpace seam.
test('joining via a mirall://join App link resolves to the same space as the bare code', async (t) => {
  await freshPeer(t)
  const topic = b4a.toString(b4a.alloc(32, 5), 'hex')
  const env = encodeInvite({ topic, name: 'Aurora' })

  const fromLink = decodeInvite(`mirall://join/${env}`)
  t.is(fromLink.topic, topic, 'deep link decodes to the invite topic')
  t.is(fromLink.name, 'Aurora', 'deep link preserves the space name')

  const a = await joinSpace(fromLink.topic, fromLink.name)
  const b = await joinSpace(decodeInvite(env).topic, 'Aurora')
  t.is(a.spaceId, b.spaceId, 'link and bare code join the same space')
  t.is((await listSpaces()).filter((s) => s.spaceId === a.spaceId).length, 1, 'not duplicated')
})

test('an invite without an inviter (legacy/omitted) seeds no shell', async (t) => {
  await freshPeer(t)
  const topic = b4a.toString(b4a.alloc(32, 8), 'hex')
  const decoded = decodeInvite(encodeInvite({ topic, name: 'Aurora' }))
  t.is(decoded.owner, undefined, 'no inviter in the envelope')
  const space = await joinSpace(decoded.topic, decoded.name)
  t.is((await getSpace(space.spaceId)).members.length, 0, 'no members seeded')
})
