import test from 'brittle'
import { effectiveAudit, effectiveBackup, effectiveNetwork, lockedKeys } from '../../src/shared/core/managed-effective.js'
import { assertUnlocked, isLocked, resetManagedOverlay, setManagedOverlay } from '../../src/shared/core/managed-overlay.js'
import { MANAGED_SETTING_KEYS } from '../../src/shared/contract/managed-settings.js'

const ownRelay = { publicKey: 'yhdoqba8yhdoqba8yhdoqba8yhdoqba8yhdoqba8yhdoqba8yhdo', kind: 'private', label: 'Mine', enabled: true, lastTest: null }
const own = { relayMode: 'auto', relay: ownRelay }
const stored = { enabled: false, retentionDays: 30, maxEntries: 5000 }
const managed = {
  organization: { name: 'Acme GmbH '.repeat(10).trim() },
  settings: { 'network.relayMode': 'always', 'network.relayKey': 'yryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyo', 'audit.enabled': true, 'audit.retentionDays': 365, 'backup.required': true },
  backup: { folder: '/Volumes/mirall/anna/x-1', base: '/Volumes/mirall', create: ['/Volumes/mirall/anna', '/Volumes/mirall/anna/x-1'] },
}

test('without an overlay every value is the person\'s own, identically', (t) => {
  const net = effectiveNetwork(own, null)
  t.is(net.relayMode, 'auto')
  t.is(net.relay, ownRelay)
  t.alike(effectiveAudit(stored, null), stored)
  t.alike(effectiveBackup({ folder: '/mine' }, null), { folder: '/mine', managed: null, required: false })
  t.alike(lockedKeys(null), [])
  resetManagedOverlay()
  for (const key of MANAGED_SETTING_KEYS) t.absent(isLocked(key), key)
})

test('a locked value wins; the person\'s slot survives underneath', (t) => {
  const net = effectiveNetwork(own, managed, { at: 1, ok: true })
  t.is(net.relayMode, 'always')
  t.is(net.relay.kind, 'open')
  t.ok(net.relay.label.length <= 64)
  t.alike(net.relay.lastTest, { at: 1, ok: true })
  t.is(effectiveNetwork(own, null).relay, ownRelay)
  t.alike(effectiveAudit(stored, managed), { enabled: true, retentionDays: 365, maxEntries: 5000 })
  t.alike(effectiveBackup({ folder: '/mine' }, managed), { folder: managed.backup.folder, managed: managed.backup, required: true })
})

test('assertUnlocked refuses a change, never a re-send', (t) => {
  setManagedOverlay(managed)
  t.exception(() => assertUnlocked('network.relayMode', 'off', 'always', 'network:set-relay'), /MANAGED_LOCKED|set by your organization/)
  t.execution(() => assertUnlocked('network.relayMode', 'always', 'always', 'network:set-relay'))
  t.execution(() => assertUnlocked('network.relayMode', undefined, 'always', 'network:set-relay'))
  t.execution(() => assertUnlocked('backup.folder.macos', '/x', '/y', 'backup:configure'))
  t.execution(() => assertUnlocked('network.relayKey', { publicKey: 'k' }, { publicKey: 'k', label: 'x' }, 'network:set-relay'))
  resetManagedOverlay()
  t.execution(() => assertUnlocked('network.relayMode', 'off', 'always', 'network:set-relay'))
})

test('REGRESSION (FIX-1: unresolved folder template): a template that does not resolve here locks nothing', (t) => {
  const settings = { 'backup.folder.macos': '/{install}', 'backup.folder.linux': '/{install}', 'audit.enabled': true }
  t.alike(lockedKeys({ organization: managed.organization, settings, backup: null }), ['audit.enabled'])
  t.alike(lockedKeys({ organization: managed.organization, settings, backup: { folder: '/x/y', base: '/x', create: ['y'] } }).sort(), Object.keys(settings).sort())
})
