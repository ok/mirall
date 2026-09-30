import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay, revokeServesForSpace } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { serveIndex } from '../../src/shared/transfer/overlay/overlay-serve-index.js'
import { addPeer } from '../helpers/overlay-engine.js'

// REGRESSION (FIX-3): a leave must revoke the grants for the space being left WITHOUT cutting off
// co-members who pull the same content via another space. Content is deduplicated by hash, so one
// content:<hash> grant can be entitled by more than one space; revoking it space-wide would stall
// an innocent transfer in a space we are staying in.

const HASH_SHARED = 'a'.repeat(64) // advertised by spaceLeave AND spaceKeep
const HASH_LEAVE_ONLY = 'b'.repeat(64) // advertised only by spaceLeave

// One peer per grant is enough: revokeServes walks every peer's grants.
function grant(proto, hash, from) {
  const peer = addPeer(proto, { mux: from + hash })
  proto.grants.grant(peer, 'content:' + hash, from, 0)
  return peer
}

async function setup(t) {
  const ctx = await freshPeer(t)
  await initOverlay()
  serveIndex._reset?.()
  t.teardown(async () => { getOverlay()?.protocol?.channel.clear(); await teardownOverlay(); serveIndex._reset?.() })
  return ctx
}

test('leaving a space revokes only the hashes it SOLELY advertises, sparing a hash shared with a kept space', async (t) => {
  await setup(t)
  const proto = getOverlay().protocol

  serveIndex.add(HASH_SHARED, 'spaceLeave', 'share1', 'f.bin')
  serveIndex.add(HASH_SHARED, 'spaceKeep', 'share2', 'f.bin') // same bytes, a space we remain in
  serveIndex.add(HASH_LEAVE_ONLY, 'spaceLeave', 'share1', 'g.bin')

  const sharedPeer = grant(proto, HASH_SHARED, 'bob')
  const leaveOnlyPeer = grant(proto, HASH_LEAVE_ONLY, 'carol')

  const revoked = revokeServesForSpace('spaceLeave')

  t.is(revoked, 1, 'only the leave-exclusive hash is revoked')
  t.ok(sharedPeer.authorizedServe.has('content:' + HASH_SHARED),
    'a hash also advertised by a space we keep stays served — the co-member is not cut off')
  t.absent(leaveOnlyPeer.authorizedServe.has('content:' + HASH_LEAVE_ONLY),
    'a hash the left space solely advertised is revoked')
})

test('a peer-scoped revoke only touches the named requester', async (t) => {
  await setup(t)
  const proto = getOverlay().protocol
  serveIndex.add(HASH_LEAVE_ONLY, 'spaceLeave', 'share1', 'g.bin')

  const leaver = grant(proto, HASH_LEAVE_ONLY, 'leaver')
  const other = grant(proto, HASH_LEAVE_ONLY, 'other')

  t.is(revokeServesForSpace('spaceLeave', 'leaver'), 1, 'only the leaver is revoked')
  t.absent(leaver.authorizedServe.has('content:' + HASH_LEAVE_ONLY), 'the leaver stops being served')
  t.ok(other.authorizedServe.has('content:' + HASH_LEAVE_ONLY), 'another member on the same hash keeps its grant')
})
