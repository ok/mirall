import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { getSpace } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { forgetSpaceRecord, persistPendingLeave, clearPendingLeave, listPendingLeaves } from '../../src/shared/spaces/leave-records.js'

// The pending-leave marker is the durable half of the leave-while-alone recovery: it must
// carry the topic, the original leave ts and the roster the replay may serve, and — critically —
// survive the space-record purge that the leave teardown performs right after writing it.
test('REGRESSION (FIX-E1: the pending-leave marker outlives the space record purge)', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Ephemeral')
  const ts = Date.now()
  const members = ['aa'.repeat(32), 'bb'.repeat(32)]

  await persistPendingLeave(space.spaceId, space.topic, ts, members)
  await forgetSpaceRecord(space.spaceId)

  t.absent(await getSpace(space.spaceId), 'space record purged')
  const markers = await listPendingLeaves()
  t.is(markers.length, 1, 'the marker survived the purge')
  t.alike(markers[0], { spaceId: space.spaceId, topic: space.topic, ts, members }, 'topic, leave ts and the roster it is owed to intact for the replay')

  await clearPendingLeave(space.spaceId)
  t.is((await listPendingLeaves()).length, 0, 'ack-driven clear retires it')
  await clearPendingLeave(space.spaceId)
  t.pass('clearing an absent marker is a no-op')
})
