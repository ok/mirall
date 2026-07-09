import test from 'brittle'
import { classifyInvite, snapshotCandidates } from '../../src/shared/spaces/invite-policy.js'

const NOW = 1_000_000

test('absent record classifies as manual', (t) => {
  t.is(classifyInvite(null, NOW), 'manual')
})

test('auto, unexpired classifies as auto', (t) => {
  t.is(classifyInvite({ autoApprove: true, expiresAt: NOW + 1 }, NOW), 'auto')
})

test('review, unexpired classifies as manual', (t) => {
  t.is(classifyInvite({ autoApprove: false, expiresAt: NOW + 1 }, NOW), 'manual')
})

test('auto, expired classifies as expired (E1: link dead)', (t) => {
  t.is(classifyInvite({ autoApprove: true, expiresAt: NOW - 1 }, NOW), 'expired')
})

test('review, expired classifies as expired', (t) => {
  t.is(classifyInvite({ autoApprove: false, expiresAt: NOW - 1 }, NOW), 'expired')
})

test('null expiry never expires', (t) => {
  t.is(classifyInvite({ autoApprove: true, expiresAt: null }, NOW), 'auto')
})

test('a record flagged expired classifies as expired regardless of expiresAt', (t) => {
  t.is(classifyInvite({ autoApprove: true, expired: true }, NOW), 'expired')
})

// The local snapshot may only answer for a member that is genuinely OFFLINE. A live read
// that merely timed out against a CONNECTED peer says nothing about the record: trusting a
// stale prefix there would auto-admit a link that peer has since revoked (fail-open), where
// falling through to manual approval is the safe outcome.
const FAILED = null
const RESOLVED = (value) => ({ resolved: true, value })

test('snapshotCandidates: only failed reads from disconnected members qualify', (t) => {
  const keys = ['a', 'b', 'c', 'd']
  const live = [FAILED, FAILED, RESOLVED(null), RESOLVED({ autoApprove: true })]
  const connected = new Set(['b'])
  t.alike(
    snapshotCandidates(keys, live, (k) => connected.has(k)),
    ['a'],
    'a=offline+failed qualifies; b=connected+timed-out excluded; c/d answered live',
  )
})

test('snapshotCandidates: a timed-out read from a CONNECTED member never falls back', (t) => {
  t.alike(snapshotCandidates(['m'], [FAILED], () => true), [], 'no stale answer while reachable')
  t.alike(snapshotCandidates(['m'], [FAILED], () => false), ['m'], 'offline member may answer locally')
})

test('snapshotCandidates: a resolved live read is never second-guessed', (t) => {
  t.alike(snapshotCandidates(['m'], [RESOLVED(null)], () => false), [], 'authoritative absence (revoked) stands')
  t.alike(snapshotCandidates(['m'], [RESOLVED({ autoApprove: false })], () => false), [], 'live value stands')
})

test('classifyInvite ignores the stale marker the snapshot fallback adds', (t) => {
  t.is(classifyInvite({ autoApprove: true, expiresAt: null, stale: true }, NOW), 'auto')
  t.is(classifyInvite({ autoApprove: true, expiresAt: NOW - 1, stale: true }, NOW), 'expired', 'expiry still enforced offline')
})
