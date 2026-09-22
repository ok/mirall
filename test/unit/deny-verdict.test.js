import test from 'brittle'
import { ASK_PEERS, denyVerdict } from '../../src/shared/spaces/knock-policy.js'

const none = { isMember: false, hadLeft: false, isApproved: false, recentlyApproved: false, hasOpenRequest: true, vouched: undefined }

const ROWS = [
  ['a current member', { isMember: true }, 'already-approved'],
  ['a folded approval', { isApproved: true }, 'already-approved'],
  ['a member we saw leave, request open', { isMember: true, hadLeft: true }, ASK_PEERS],
  ['a folded approval of a leaver, request open', { isApproved: true, hadLeft: true }, ASK_PEERS],
  ['a recent already-approved answer, even with the row gone', { recentlyApproved: true, hasOpenRequest: false }, 'already-approved'],
  ['no open request', { hasOpenRequest: false }, 'not-applicable'],
  ['a member wins over a missing request', { isMember: true, hasOpenRequest: false }, 'already-approved'],
  ['an open request, peers not asked yet', {}, ASK_PEERS],
  ['a co-member vouches', { vouched: true }, 'already-approved'],
  ['a co-member vouches for a leaver', { vouched: true, hadLeft: true }, 'denied'],
  ['nobody vouches', { vouched: false }, 'denied'],
  ['the request closed during the peer read', { vouched: false, hasOpenRequest: false }, 'not-applicable'],
  ['admitted during the peer read', { vouched: false, isMember: true }, 'already-approved'],
]

test('denyVerdict: local facts, then the open request, then the co-members', (t) => {
  for (const [label, facts, want] of ROWS) t.is(denyVerdict({ ...none, ...facts }), want, label)
})
