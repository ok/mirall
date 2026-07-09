import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import {
  createSpace, forgetSpaceRecord, getSpace,
  persistPendingLeave, clearPendingLeave, listPendingLeaves,
} from '../../src/shared/spaces/space.js'

// The pending-leave marker is the durable half of the leave-while-alone recovery: it must
// carry the topic + original leave ts, and — critically — survive the space-record purge
// that the leave teardown performs right after writing it.
test('REGRESSION (FIX-E1: the pending-leave marker outlives the space record purge)', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Ephemeral')
  const ts = Date.now()

  await persistPendingLeave(space.spaceId, space.topic, ts)
  await forgetSpaceRecord(space.spaceId)

  t.absent(await getSpace(space.spaceId), 'space record purged')
  const markers = await listPendingLeaves()
  t.is(markers.length, 1, 'the marker survived the purge')
  t.alike(markers[0], { spaceId: space.spaceId, topic: space.topic, ts }, 'topic + leave ts intact for the replay')

  await clearPendingLeave(space.spaceId)
  t.is((await listPendingLeaves()).length, 0, 'ack-driven clear retires it')
  await clearPendingLeave(space.spaceId)
  t.pass('clearing an absent marker is a no-op')
})
