import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { ownParticipationId } from '../../src/shared/core/store.js'
import { getSpace, getSpaceContentKey, listSpaces, mutateSpace } from '../../src/shared/spaces/space.js'
import { getProfileBee, clearOwnMembership } from '../../src/shared/spaces/profile.js'
import { purgeSpace } from '../../src/shared/spaces/leave-records.js'
import { createSpace, joinSpace, materializeSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getOwnParticipationId, isParticipating } from '../../src/shared/spaces/participation.js'

const announced = async (spaceId) => (await getProfileBee().get('drive/' + spaceId))?.value ?? null

test('creating a space announces the participation id the record derives', async (t) => {
  await freshPeer(t)
  const created = await createSpace('Aurora')
  const space = await getSpace(created.spaceId)
  const id = getOwnParticipationId(space.spaceId, space)
  t.ok(/^[0-9a-f]{64}$/.test(id), 'a 32-byte hex id')
  t.is(id, ownParticipationId(space.spaceId, space.driveSuffix), 'derived from the record suffix')
  t.is(await announced(space.spaceId), id, 'published under drive/<spaceId>')
})

// A leave purges the record, so a rejoin mints a fresh suffix: co-members see a new participation,
// never the old one resurrected.
test('a rejoin after a leave is a new participation, announced only once granted', async (t) => {
  await freshPeer(t)
  const created = await createSpace('Aurora')
  const first = await getSpace(created.spaceId)
  const firstId = getOwnParticipationId(first.spaceId, first)
  const sck = getSpaceContentKey(first.spaceId, first)

  await clearOwnMembership(first.spaceId)
  await purgeSpace(first.spaceId)
  t.is(await announced(first.spaceId), null, 'the leave takes the announced id with it')

  const rejoined = await joinSpace(first.topic, 'Aurora')
  t.is(rejoined.pending, true)
  t.is(getOwnParticipationId(rejoined.spaceId, await getSpace(rejoined.spaceId)), null, 'a pending joiner has no participation')
  t.is(await announced(rejoined.spaceId), null, 'and announces none')

  const granted = await materializeSpace(rejoined.spaceId, sck)
  const secondId = getOwnParticipationId(granted.spaceId, granted)
  t.not(granted.driveSuffix, first.driveSuffix, 'a fresh suffix')
  t.not(secondId, firstId, 'so a fresh id')
  t.is(await announced(granted.spaceId), secondId, 'announced on the grant')
})

test('the departure record and the id delete land together', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  await clearOwnMembership(spaceId)
  t.is((await getProfileBee().get('member/' + spaceId)).value.active, false, 'the departure is recorded')
  t.is(await announced(spaceId), null, 'the id is gone')
})

// A profile bee that refuses writes, so each announce fails the way a closing session would.
function failProfileWrites(t) {
  const bee = getProfileBee()
  const realPut = bee.put.bind(bee)
  bee.put = () => Promise.reject(new Error('EIO: injected profile write failure'))
  const restore = () => { bee.put = realPut }
  t.teardown(restore)
  return restore
}

test('a create whose announce fails leaves no space behind', async (t) => {
  await freshPeer(t)
  const before = (await listSpaces()).length
  failProfileWrites(t)
  await t.exception(createSpace('Aurora'), /injected profile write failure/)
  t.is((await listSpaces()).length, before, 'no half-created space')
})

// The grant flips the space to approved only after the announce, so a failure leaves it pending and
// the next grant — which the grant handler accepts only for a pending space — retries everything.
test('a grant whose announce fails leaves the space pending, and the next grant completes it', async (t) => {
  await freshPeer(t)
  const created = await createSpace('Aurora')
  const first = await getSpace(created.spaceId)
  const sck = getSpaceContentKey(first.spaceId, first)
  await clearOwnMembership(first.spaceId)
  await purgeSpace(first.spaceId)
  const joined = await joinSpace(first.topic, 'Aurora')

  const restore = failProfileWrites(t)
  await t.exception(materializeSpace(joined.spaceId, sck), /injected profile write failure/)
  t.is((await getSpace(joined.spaceId)).status, 'pending', 'still pending after the failed announce')

  restore()
  const granted = await materializeSpace(joined.spaceId, sck)
  t.is(granted.status, 'approved')
  t.is(await announced(joined.spaceId), getOwnParticipationId(granted.spaceId, granted), 'announced on the retry')
})

test('a space being left no longer participates', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const leaving = await mutateSpace(spaceId, (s) => ({ ...s, leaving: true }))
  t.absent(isParticipating(leaving))
  t.is(getOwnParticipationId(spaceId, leaving), null)
})

// A rejoin that reuses a record an interrupted leave left behind: the leave already retracted the
// announced id, so the rejoin must publish it again.
test('rejoining through an interrupted leave re-announces the id', async (t) => {
  await freshPeer(t)
  const created = await createSpace('Aurora')
  await mutateSpace(created.spaceId, (s) => ({ ...s, leaving: true }))
  await clearOwnMembership(created.spaceId)
  t.is(await announced(created.spaceId), null, 'precondition: the leave retracted it')

  const rejoined = await joinSpace(created.topic, 'Aurora')
  t.absent(rejoined.leaving)
  t.is(await announced(created.spaceId), getOwnParticipationId(created.spaceId, rejoined))
})

// A batch holds the bee's write lock until it flushes or closes; one left open would stall every
// later profile write.
test('a failed departure write releases the profile bee', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const bee = getProfileBee()
  const realBatch = bee.batch.bind(bee)
  bee.batch = () => {
    const batch = realBatch()
    batch.del = () => Promise.reject(new Error('EIO: injected batch failure'))
    return batch
  }
  t.teardown(() => { bee.batch = realBatch })
  await t.exception(clearOwnMembership(spaceId), /injected batch failure/)

  bee.batch = realBatch
  const write = bee.put('probe', 1).then(() => 'written')
  const stalled = new Promise((resolve) => setTimeout(() => resolve('stalled'), 2000))
  t.is(await Promise.race([write, stalled]), 'written', 'the next write goes through')
})
