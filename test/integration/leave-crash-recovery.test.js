import test from 'brittle'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { createSpace, joinSpace, getSpace, forgetSpaceRecord, markSpaceLeavingDurable, resumeInterruptedLeave } from '../../src/shared/spaces/space.js'
import { markOwnMembership, clearOwnMembership, readMembershipRecord, getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createOwnedMount, createForeignMount, listOwnedMounts, listForeignMounts } from '../../src/shared/folders/mount-store.js'
import { publishShare, readOwnShares } from '../../src/shared/shares/shares.js'

// Identity mode + v2 spaces — the production-default shape for leave/teardown paths.

async function memberActive (spaceId) {
  const rec = await readMembershipRecord(getLocalPublicKeyHex(), spaceId)
  return !!rec?.active
}

// REGRESSION (G4): a leave interrupted after clearOwnMembership but before forgetSpaceRecord must
// NOT be resurrected at boot. Before the fix, boot's markOwnMembership re-PUT active:true because
// clearOwnMembership had del'd the record (the "already active? keep" guard misses a del).
test('REGRESSION (G4): boot completes a mid-leave space instead of re-marking it', async (t) => {
  await freshPeerWithIdentity(t)
  const { spaceId } = await createSpace('Aurora')
  await markOwnMembership(spaceId)
  t.ok(await memberActive(spaceId), 'precondition: active member of own space')

  // Exact interrupted state: durable marker set, member record del'd, space record still present.
  await markSpaceLeavingDurable(spaceId)
  await clearOwnMembership(spaceId)
  t.absent(await memberActive(spaceId), 'precondition: membership cleared')
  t.ok((await getSpace(spaceId))?.leaving, 'precondition: durable leaving marker persisted')

  // The boot loop's decision for a leaving space: complete it, DO NOT markOwnMembership.
  await resumeInterruptedLeave(spaceId)

  t.absent(await getSpace(spaceId), 'space record forgotten — leave completed')
  t.absent(await memberActive(spaceId), 'membership stayed cleared — NOT resurrected')
})

// The boot loop must EXCLUDE leaving spaces from markOwnMembership: running it on the
// interrupted space (as the old loop did) revives the membership.
test('REGRESSION (G4): markOwnMembership on a mid-leave space revives it (proves the exclusion matters)', async (t) => {
  await freshPeerWithIdentity(t)
  const { spaceId } = await createSpace('Boreal')
  await markSpaceLeavingDurable(spaceId)
  await clearOwnMembership(spaceId)

  await markOwnMembership(spaceId) // the OLD (buggy) boot behavior

  t.ok(await memberActive(spaceId), 'confirms the bug: unconditional re-mark revives membership')
})

// REGRESSION (G4/#348): the boot restart loops iterate the MOUNT stores, so completion must
// delete the space's mount records or a watcher/mirror is re-armed against a forgotten space.
// Own share ads are tombstoned for the same reason folder-teardown does it: a later genuine
// rejoin must not re-surface them.
test('REGRESSION (G4): resumeInterruptedLeave drops mount records and tombstones own share ads', async (t) => {
  await freshPeerWithIdentity(t)
  const { spaceId } = await createSpace('Umbra')
  await createOwnedMount({ spaceId, shareId: 'sh-own', mountPath: '/tmp/x', enabled: true })
  await createForeignMount({ spaceId, shareId: 'sh-for', mountPath: '/tmp/y', enabled: true })
  await publishShare(spaceId, { id: 'sh-own', name: 'X' })
  t.is((await readOwnShares(spaceId)).length, 1, 'precondition: live share ad')

  await markSpaceLeavingDurable(spaceId)
  await resumeInterruptedLeave(spaceId)

  t.alike((await listOwnedMounts()).filter((m) => m.spaceId === spaceId), [], 'owned mount gone')
  t.alike((await listForeignMounts()).filter((m) => m.spaceId === spaceId), [], 'foreign mount gone')
  t.alike(await readOwnShares(spaceId), [], 'share ad tombstoned')
})

// A clean (completed) leave deletes the whole record via forgetSpaceRecord — the live
// teardown's own completion step — so no marker survives for boot to see.
test('G4: a completed leave carries no leaving marker', async (t) => {
  await freshPeerWithIdentity(t)
  const { spaceId } = await createSpace('Cirrus')
  await markSpaceLeavingDurable(spaceId)
  await forgetSpaceRecord(spaceId)
  t.absent(await getSpace(spaceId), 'no record (and thus no marker) after the clean teardown step')
})

// REGRESSION (review): joinSpace used to return an existing record verbatim, so a stale
// `leaving` marker (an interrupted leave whose boot completion failed) survived a rejoin —
// and the NEXT boot silently deleted the space the user just rejoined.
test('REGRESSION (G4): rejoining a leaving-marked space clears the marker', async (t) => {
  await freshPeerWithIdentity(t)
  const space = await createSpace('Dorado')
  await markSpaceLeavingDurable(space.spaceId)
  t.ok((await getSpace(space.spaceId))?.leaving, 'precondition: marker persisted')

  const rejoined = await joinSpace(space.topic)

  t.absent(rejoined.leaving, 'rejoin returns the record without the marker')
  t.absent((await getSpace(space.spaceId))?.leaving, 'marker durably cleared — boot will not resume the leave')
})
