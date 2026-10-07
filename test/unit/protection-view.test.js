import test from 'brittle'
import { protectionBanner, protectionLamp, passphraseLine, backupSummary } from '../../src/renderer/model/protection-view.js'

const T = Date.UTC(2026, 9, 1)
const KEY = { createdAt: '2026-10-01T00:00:00.000Z', inFolder: true, checkedAt: T, reminders: true }
const BASE = {
  folder: '/Volumes/Backup', repoId: 'r', state: 'idle', lastSuccessAt: T, lastSnapshot: 's', lastError: null,
  suspect: null, key: KEY, prompt: null, stale: false, verdict: 'protected', verdictReason: null,
}
const status = (patch) => ({ ...BASE, ...patch })

test('the banner names each cause and offers the one fix', (t) => {
  t.alike(protectionBanner(BASE), { lamp: 'protected', key: 'protected', fix: 'run' }, 'a protected backup still offers Back up now')
  t.alike(protectionBanner(status({ folder: null, verdict: 'at-risk', verdictReason: 'not-set-up' })), { lamp: 'at-risk', key: 'notSetUp', fix: 'setup' })
  t.alike(protectionBanner(status({ verdict: 'at-risk', verdictReason: 'unconfirmed' })), { lamp: 'at-risk', key: 'unconfirmed', fix: 'check' })
  t.alike(protectionBanner(status({ verdict: 'at-risk', verdictReason: 'failing' })), { lamp: 'at-risk', key: 'failing', fix: 'run' })
  t.alike(protectionBanner(status({ verdict: 'stopped', verdictReason: 'stale' })), { lamp: 'stopped', key: 'stale', fix: 'run' })
  t.alike(protectionBanner(status({ verdict: 'stopped', verdictReason: 'no-key' })), { lamp: 'stopped', key: 'noKey', fix: 'new-key' })
  t.alike(protectionBanner(status({ state: 'paused', verdict: null })), { lamp: 'paused', key: 'paused', fix: null })
  t.is(protectionBanner(status({ state: 'off', verdict: null })), null, 'nothing to say with no service on this worker')
  t.is(protectionLamp(status({ state: 'paused', verdict: null })), 'paused')
})

test('the passphrase line says whether it was chosen and when it was last checked', (t) => {
  t.alike(passphraseLine(BASE), { key: 'backup.passphraseOk', at: T })
  t.alike(passphraseLine(status({ key: { ...KEY, checkedAt: null } })), { key: 'backup.passphraseUnconfirmed', at: null })
  t.alike(passphraseLine(status({ key: { ...KEY, createdAt: null } })), { key: 'backup.passphraseNone', at: null })
})

test('the Profile summary is the backup alone, in one sentence', (t) => {
  t.alike(backupSummary(BASE), { key: 'protection.summary.backedUp', at: T })
  t.is(backupSummary(status({ verdict: 'at-risk', verdictReason: 'unconfirmed' })).key, 'protection.summary.attention', 'at risk says what needs attention')
  t.is(backupSummary(status({ folder: null, verdict: 'at-risk', verdictReason: 'not-set-up' })).key, 'protection.summary.notBackedUp')
  t.is(backupSummary(status({ verdict: 'stopped', verdictReason: 'stale' })).key, 'protection.summary.stopped')
  t.is(backupSummary(status({ state: 'paused', verdict: null })).key, 'protection.summary.paused')
})
