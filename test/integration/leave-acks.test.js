import test from 'brittle'
import { leaveAcksSatisfied, awaitLeaveAcks } from '../../src/shared/transfer/swarm.js'

// Phase 3: the leaver waits (bounded) for connected members to confirm they applied the leave — an
// observed signal that the durable revokeApproval ran on the approvers — instead of a blind sleep.

test('leaveAcksSatisfied: every expected member must have acked', (t) => {
  t.ok(leaveAcksSatisfied(new Set(), new Set()), 'no expected members → trivially satisfied')
  t.ok(leaveAcksSatisfied(new Set(['a']), new Set(['a', 'b'])), 'all expected present → satisfied')
  t.absent(leaveAcksSatisfied(new Set(['a', 'b']), new Set(['a'])), 'a missing ack → not satisfied')
})

// No leave was broadcast for this space, so `leaveAcks` holds no tracking Set → awaitLeaveAcks takes
// the `!received` fast path and returns immediately rather than blocking the cap. (The
// acks-seeded-but-zero-members and full-coverage paths run in the swarm; the pure gate above covers
// the decision.)
test('awaitLeaveAcks: no leave in progress → resolves immediately, never blocks the cap', async (t) => {
  const t0 = Date.now()
  t.ok(await awaitLeaveAcks('nospace000000000', { capMs: 2000 }), 'returns true (nothing to wait for)')
  t.ok(Date.now() - t0 < 200, 'did not wait the cap')
})
