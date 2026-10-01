import test from 'brittle'
import { protectionBanner, protectionLamp, recoveryKeyRow, keyCopyRow, protectionSummary } from '../../src/renderer/model/protection-view.js'

const T = Date.UTC(2026, 9, 1)
const KEY = { createdAt: '2026-10-01T00:00:00.000Z', inFolder: true, checkedAt: T, secondCopyAt: null, reminders: true }
const BASE = {
  enabled: true, folder: '/Volumes/Backup', repoId: 'r', state: 'idle', lastSuccessAt: T, lastSnapshot: 's', lastError: null,
  suspect: null, key: KEY, prompt: null, stale: false, verdict: 'protected', verdictReason: null,
}
const status = (patch) => ({ ...BASE, ...patch })

test('the banner names each cause and offers the one fix', (t) => {
  t.alike(protectionBanner(BASE), { lamp: 'protected', key: 'protected', fix: null })
  t.alike(protectionBanner(status({ folder: null, verdict: 'at-risk', verdictReason: 'not-set-up' })), { lamp: 'at-risk', key: 'notSetUp', fix: 'setup' })
  t.alike(protectionBanner(status({ verdict: 'at-risk', verdictReason: 'unconfirmed' })), { lamp: 'at-risk', key: 'unconfirmed', fix: 'check' })
  t.alike(protectionBanner(status({ verdict: 'at-risk', verdictReason: 'failing' })), { lamp: 'at-risk', key: 'failing', fix: 'run' })
  t.alike(protectionBanner(status({ verdict: 'stopped', verdictReason: 'stale' })), { lamp: 'stopped', key: 'stale', fix: 'run' })
  t.alike(protectionBanner(status({ verdict: 'stopped', verdictReason: 'no-key' })), { lamp: 'stopped', key: 'noKey', fix: 'new-key' })
  t.alike(protectionBanner(status({ state: 'paused', verdict: null })), { lamp: 'paused', key: 'paused', fix: null })
  t.is(protectionBanner(status({ enabled: false, state: 'off', verdict: null })), null, 'nothing to say with the feature off')
  t.is(protectionLamp(status({ state: 'paused', verdict: null })), 'paused')
})

test('the recovery key row follows the key, the copy row says what it copies', (t) => {
  t.alike(recoveryKeyRow(BASE), { health: 'ok', key: 'backup.rowKeyOk', at: T, action: 'check' })
  t.is(recoveryKeyRow(status({ key: { ...KEY, checkedAt: null } })).key, 'backup.rowKeyUnconfirmed')
  t.is(recoveryKeyRow(status({ key: { ...KEY, inFolder: false } })).key, 'backup.rowKeyNotInFolder')
  t.alike(recoveryKeyRow(status({ key: { ...KEY, createdAt: null } })), { health: 'attention', key: 'backup.rowKeyMissing', at: null, action: 'new-key' })
  t.is(recoveryKeyRow(status({ folder: null, key: { ...KEY, createdAt: null } })).action, null, 'before setup the verdict carries the action')
  t.alike(keyCopyRow(BASE), { health: 'tip', key: 'backup.rowCopyNone', at: null, canSave: true })
  t.is(keyCopyRow(status({ key: { ...KEY, secondCopyAt: T } })).key, 'backup.rowCopyOk')
  t.is(keyCopyRow(status({ key: { ...KEY, createdAt: null } })).key, 'protection.copyAfterKey', 'set up, but no key yet')
  t.is(keyCopyRow(status({ folder: null, key: { ...KEY, createdAt: null } })).key, 'protection.copyLater')
})

test('the Profile summary leads with the identity key once known, and stands alone before', (t) => {
  t.alike(protectionSummary(BASE, 'protected'), { lead: 'protection.summary.keyProtected', data: 'protection.summary.backedUp', at: T })
  t.is(protectionSummary(BASE, 'disabled').lead, 'protection.summary.keyDisabled', 'disabled is not "weak"')
  t.alike(protectionSummary(BASE, null), { lead: null, data: 'protection.summary.backedUpAlone', at: T })
  t.is(protectionSummary(status({ verdict: 'at-risk', verdictReason: 'unconfirmed' }), 'weak').data, 'protection.summary.attention', 'at risk says what needs attention')
  t.is(protectionSummary(status({ folder: null, verdict: 'at-risk', verdictReason: 'not-set-up' }), 'weak').data, 'protection.summary.notBackedUp')
  t.is(protectionSummary(status({ verdict: 'stopped', verdictReason: 'stale' }), 'protected').data, 'protection.summary.stopped')
  t.is(protectionSummary(status({ state: 'paused', verdict: null }), 'protected').data, 'protection.summary.paused')
})
