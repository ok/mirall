import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { joinSpace, createSpace, listSpaces, getDrive, getSpace, upsertMember } from '../../src/shared/spaces/space.js'
import { encodeInvite, decodeInvite } from '../../src/shared/invite-envelope.js'

test('re-joining the same invite topic is idempotent (one space, still pending)', async (t) => {
  await freshPeer(t)
  const topic = b4a.toString(b4a.alloc(32, 9), 'hex')
  const a = await joinSpace(topic, 'Project')
  const b = await joinSpace(topic, 'Project (again)')
  t.is(a.spaceId, b.spaceId, 'spaceId derived from the topic')
  t.is((await listSpaces()).filter((s) => s.spaceId === a.spaceId).length, 1, 'not duplicated')
  // The writable drive is minted on grant (materializeOwnDrive), not at join.
  t.is((await getSpace(a.spaceId)).status, 'pending', 'still pending after the second join')
  t.absent(getDrive(a.spaceId), 'no drive while pending')
})

test('joining a space you created returns the existing record (no-op)', async (t) => {
  await freshPeer(t)
  const created = await createSpace('Mine')
  const joined = await joinSpace(created.topic, 'Mine')
  t.is(joined.spaceId, created.spaceId)
})

// Joining via an invite that carries the inviter's identity should pre-seed them
// as an offline shell member (default avatar, no driveKey) so the space isn't
// empty before their first handshake — and the handshake must merge into that
// shell by public key rather than adding a duplicate. Mirrors the building blocks
// the space:join handler composes (decodeInvite → joinSpace → upsertMember) and
// the handshake path (upsertMember with driveKey).
test('an invite carrying the inviter seeds an offline shell member that the handshake merges', async (t) => {
  await freshPeer(t)
  const topic = b4a.toString(b4a.alloc(32, 7), 'hex')
  const ownerKey = 'b'.repeat(64)

  const decoded = decodeInvite(encodeInvite({ topic, name: 'Aurora', owner: ownerKey, ownerName: 'Alice' }))
  t.is(decoded.owner, ownerKey, 'envelope round-trips the inviter key')
  t.is(decoded.ownerName, 'Alice', 'envelope round-trips the inviter name')

  const space = await joinSpace(decoded.topic, decoded.name)
  await upsertMember(space.spaceId, { publicKey: decoded.owner, displayName: decoded.ownerName })

  let members = (await getSpace(space.spaceId)).members
  t.is(members.length, 1, 'inviter seeded as the sole member')
  t.is(members[0].publicKey, ownerKey, 'keyed by the inviter public key')
  t.is(members[0].displayName, 'Alice', 'shows the invited display name')
  t.is(members[0].driveKey, null, 'shell has no driveKey until the handshake')
  t.is(members[0].avatar, null, 'shell has no avatar until the handshake')

  // Handshake from the now-online inviter — same call swarm.js makes.
  await upsertMember(space.spaceId, { publicKey: ownerKey, driveKey: 'c'.repeat(64), displayName: 'Alice Renamed' })
  members = (await getSpace(space.spaceId)).members
  t.is(members.length, 1, 'merged into the shell, not duplicated')
  t.is(members[0].driveKey, 'c'.repeat(64), 'driveKey filled in by the handshake')
  t.is(members[0].displayName, 'Alice Renamed', 'display name corrected by the handshake')
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
