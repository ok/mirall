import test from 'brittle'
import { KINDS, CATEGORY, CATEGORIES, isKnownKind, categoryOf, tierOf } from '../../src/shared/contract/audit-kinds.js'

test('every kind declares a valid category and tier', (t) => {
  for (const [kind, meta] of Object.entries(KINDS)) {
    t.ok(CATEGORIES.includes(meta.category), kind + ' has a known category')
    t.ok(['A', 'B', 'C'].includes(meta.tier), kind + ' has a known tier')
  }
})

test('accessors agree with the table', (t) => {
  t.is(categoryOf('serve.completed'), CATEGORY.FILES)
  t.is(tierOf('serve.completed'), 'B')
  t.ok(isKnownKind('space.created'))
  t.absent(isKnownKind('space.exploded'))
})

test('app and device housekeeping is deliberately absent', (t) => {
  for (const kind of ['app.updated', 'app.worker_crashed', 'storage.cleanup', 'settings.download_folder', 'feedback.sent']) {
    t.absent(isKnownKind(kind), kind + ' is not an audit event — it answers no "who did what" question')
  }
})

test('recurring folder-sync churn is deliberately absent', (t) => {
  t.absent(isKnownKind('share.scan.completed'), 'the periodic reconcile records nothing')
  t.ok(isKnownKind('share.mounted'), 'the deliberate act of mounting carries the file totals instead')
})

test('there is no member-removal kind — the app has no eject capability', (t) => {
  t.absent(isKnownKind('member.removed'))
  t.ok(isKnownKind('membership.approval_revoked'), 'withdrawing our own vouch is what actually happens')
  t.is(tierOf('membership.approval_revoked'), 'C', 'it is learned through replication, not a live frame')
})

test('the security category is what remains of the old app bucket', (t) => {
  const security = Object.entries(KINDS).filter(([, m]) => m.category === CATEGORY.SECURITY).map(([k]) => k)
  t.alike(security.sort(), [
    'audit.suppressed',
    'security.creator_divergence',
    'security.integrity_failure',
    'security.serve_denied',
  ])
})

test('the network category is exactly the connectivity vocabulary', (t) => {
  const network = Object.entries(KINDS).filter(([, m]) => m.category === CATEGORY.NETWORK).map(([k]) => k)
  t.alike(network.sort(), [
    'network.at_risk',
    'network.blocked',
    'network.offline',
    'network.peer_back',
    'network.peer_lost',
    'network.restored',
  ])
})

test('the device family is first-party and the peer family is handshake-attributed', (t) => {
  for (const kind of ['network.offline', 'network.blocked', 'network.at_risk', 'network.restored']) {
    t.is(tierOf(kind), 'A', kind + ' is measured on this device')
  }
  for (const kind of ['network.peer_lost', 'network.peer_back']) {
    t.is(tierOf(kind), 'B', kind + ' rides the handshake identity binding')
  }
})

test('a settling verdict and a canary result are deliberately not kinds', (t) => {
  t.absent(isKnownKind('network.unknown'), 'one contentless row per app launch')
  t.absent(isKnownKind('network.canary_failed'), 'our seeder being down must never become the user\'s verdict')
})
