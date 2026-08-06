import test from 'brittle'
import { KINDS, CATEGORY, CATEGORIES, isKnownKind, categoryOf, tierOf } from '../../src/shared/audit/audit-kinds.js'

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
