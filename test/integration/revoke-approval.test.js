import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import {
  markApproval,
  revokeApproval,
  hasOwnApproval,
  readPeerApproval,
  getLocalPublicKeyHex,
} from '../../src/shared/spaces/profile.js'

// FIX-2: on a leave frame the approver revokeApproval()s its grant for the leaver, so a later
// rejoin needs a FRESH approval instead of a silent re-admit off the surviving grow-only record.
// hasOwnApproval gates our own admission; readPeerApproval is what co-members read. Both must flip
// to false after revoke. Read against our own key here (single peer); convergence is the flow layer.

const joiner = 'a'.repeat(64)

test('REGRESSION (FIX-2): revokeApproval clears our own approval', async (t) => {
  await freshPeer(t)
  await markApproval('space-1', joiner)
  t.ok(await hasOwnApproval('space-1', joiner), 'approved before revoke')

  await revokeApproval('space-1', joiner)
  t.absent(await hasOwnApproval('space-1', joiner), 'own approval gone after revoke')
})

test('REGRESSION (FIX-2): a revoked approval is no longer peer-readable', async (t) => {
  await freshPeer(t)
  const me = getLocalPublicKeyHex()
  await markApproval('space-1', joiner)
  t.ok(await readPeerApproval(me, 'space-1', joiner), 'approval readable by peers before revoke')

  await revokeApproval('space-1', joiner)
  t.absent(await readPeerApproval(me, 'space-1', joiner), 'approval no longer peer-readable after revoke')
})

test('revoke is scoped to the (space, joiner) and idempotent', async (t) => {
  await freshPeer(t)
  await markApproval('space-1', joiner)
  await markApproval('space-2', joiner)

  await revokeApproval('space-1', joiner)
  await revokeApproval('space-1', joiner)   // no-op second call must not throw
  t.absent(await hasOwnApproval('space-1', joiner), 'revoked in space-1')
  t.ok(await hasOwnApproval('space-2', joiner), 'space-2 approval untouched')
})
