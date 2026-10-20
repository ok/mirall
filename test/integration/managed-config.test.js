import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer, rebootPeer } from '../helpers/store.js'
import { waitFor } from '../helpers/bare-poll.js'
import { startManagedConsole } from '../helpers/managed-console.js'
import { signer, organization, sealBundle } from '../helpers/managed-seal.js'
import { registerManaged } from '../../src/worker/ipc/managed.js'
import { registerNetwork } from '../../src/worker/ipc/network.js'
import { registerAudit } from '../../src/worker/ipc/audit.js'
import { registerSettings } from '../../src/worker/ipc/settings.js'
import { getRuntimeConfig, setRuntimeConfig, getRelayConfig } from '../../src/shared/core/runtime-config.js'
import { getAuditConfig, getStoredAuditConfig } from '../../src/shared/audit/audit-log.js'
import { getManagedOverlay } from '../../src/shared/core/managed-overlay.js'
import { setAsideLockedData } from '../../src/shared/core/identity-set-aside.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'

const SIGNER = signer()
const ACME = { name: 'Acme Test GmbH', supportEmail: 'it@acme.example' }
const LOCKS = { 'network.relayMode': 'always', 'audit.enabled': true, 'audit.retentionDays': 90 }

function wire(peer) {
  const { ipc } = peer.fake
  registerManaged(ipc, { service: peer.root.managed })
  registerNetwork(ipc, { applyRelayConfig: peer.root.applyRelayConfig })
  registerAudit(ipc)
  registerSettings(ipc, { mounts: peer.root.mounts, publishRevealRoots: () => {} })
  setRuntimeConfig({ ...getRuntimeConfig(), managedTestSigningKey: SIGNER.publicHex, managedAllowHttpLoopback: true, managedPreviewTimeoutMs: 1500, managedHttpsPollMs: 1000 })
}

async function setup(t) {
  const peer = await freshPeer(t)
  wire(peer)
  const api = await startManagedConsole(t)
  const org = organization({ apiUrl: api.apiUrl })
  const serve = (settings, { issuedAt, organization: o = ACME } = {}) => api.set({
    bundles: [{ profileId: 'p1', bytes: sealBundle({ signer: SIGNER, driveKey: org.driveKey, recipients: [org.bundlePublicKey], organization: o, apiUrl: api.apiUrl, settings, issuedAt }) }],
  })
  const dataDir = path.dirname(peer.storage)
  const exists = (name) => fs.existsSync(path.join(dataDir, name))
  return { ...peer, api, org, serve, exists }
}

test('an install without a license holds nothing and answers null', async (t) => {
  const p = await setup(t)
  t.is(await p.fake.call('managed:get', {}), null)
  t.alike(p.root.managed.health().detail, { state: 'unmanaged', lastFailure: null })
  t.is(p.root.managed.timers.size, 0, 'no timer armed')
  t.absent(p.exists('managed-store'))
  t.alike(getAuditConfig(), getStoredAuditConfig(), 'the effective audit config is the stored one')
  t.is(p.api.requests.length, 0, 'nothing sent')
})

test('a preview writes nothing: an invalid code, and a drive with nothing for this key', async (t) => {
  const p = await setup(t)
  t.alike(await p.fake.call('managed:preview', { code: 'not-a-code' }), { kind: 'invalid' })
  p.api.set({ bundles: [] })
  t.alike(await p.fake.call('managed:preview', { code: p.org.code }), { kind: 'no-configuration' })
  p.api.set({ status: 404 })
  t.alike(await p.fake.call('managed:preview', { code: p.org.code }), { kind: 'no-configuration' })
  t.absent(p.exists('managed.enc'))
  t.absent(p.exists('managed-store'))
  t.is(p.root.managed.timers.size, 0)
  t.is(await p.fake.call('managed:get', {}), null)
})

test('a preview of an unreachable organization says so', async (t) => {
  const p = await setup(t)
  await p.api.close()
  t.alike(await p.fake.call('managed:preview', { code: p.org.code }), { kind: 'unreachable' })
})

test('a bundle signed by an unpinned key is not offered', async (t) => {
  const p = await setup(t)
  p.api.set({ bundles: [{ profileId: 'p1', bytes: sealBundle({ signer: signer(), driveKey: p.org.driveKey, recipients: [p.org.bundlePublicKey], organization: ACME, apiUrl: p.api.apiUrl, settings: LOCKS }) }] })
  t.alike(await p.fake.call('managed:preview', { code: p.org.code }), { kind: 'invalid' })
})

test('connect applies the locked values on top of the person\'s own, which stay as stored', async (t) => {
  const p = await setup(t)
  await p.fake.call('audit:configure', { enabled: false, retentionDays: 30 })
  p.serve(LOCKS)
  const preview = await p.fake.call('managed:preview', { code: p.org.code })
  t.is(preview.kind, 'ready')
  t.is(preview.organization.name, ACME.name)
  t.is(preview.organization.supportEmail, ACME.supportEmail)
  t.is(preview.alreadyConnected, false)
  const view = await p.fake.call('managed:accept', { code: p.org.code })
  t.is(view.organization.name, ACME.name)
  t.alike([...view.locked].sort(), Object.keys(LOCKS).sort())
  t.alike(view.values, { relayMode: 'always', retentionDays: 90 }, 'the locked values the Organization page names')
  t.ok(p.exists('managed.enc'))
  t.is(getRelayConfig().mode, 'always', 'the live relay mode is the organization\'s')
  t.is((await p.fake.call('settings:get', {})).network.relayMode, 'always', 'and so is the view')
  t.alike({ enabled: getAuditConfig().enabled, retentionDays: getAuditConfig().retentionDays }, { enabled: true, retentionDays: 90 })
  t.alike({ enabled: getStoredAuditConfig().enabled, retentionDays: getStoredAuditConfig().retentionDays }, { enabled: false, retentionDays: 30 }, 'the person\'s config is untouched')
  const reconciles = p.fake.emitted('event:reconcile').map((e) => e.payload.scope.kind)
  t.ok(reconciles.includes('managed'))
  t.ok(p.fake.emitted('event:audit-updated').length > 0)
  t.is((await p.fake.call('managed:preview', { code: p.org.code })).alreadyConnected, true)
})

test('a locked setter refuses a change and accepts the effective value', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await t.exception(p.fake.call('network:set-relay', { mode: 'off' }), /set by your organization/)
  const echoed = await p.fake.call('network:set-relay', { mode: 'always', lastTest: { at: 1, ok: true } })
  t.is(echoed.ok, true, 'the Test path re-sends the effective mode and passes')
  await t.exception(p.fake.call('audit:configure', { enabled: false }), /set by your organization/)
  await t.exception(p.fake.call('audit:configure', { retentionDays: 365 }), /set by your organization/)
  const allowed = await p.fake.call('audit:configure', { enabled: true, maxEntries: 1234 })
  t.is(allowed.maxEntries, 1234, 'a key outside the catalog stays the person\'s')
  t.is(JSON.parse(fs.readFileSync(path.join(path.dirname(p.storage), 'settings.json'), 'utf8')).network.relayMode, 'off', 'the organization\'s mode is never written as the person\'s')
})

test('the organization\'s relay is open, labelled with its name, and its Test result stays in memory', async (t) => {
  const p = await setup(t)
  const relayKey = 'yryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyo'
  p.serve({ ...LOCKS, 'network.relayKey': relayKey })
  await p.fake.call('managed:accept', { code: p.org.code })
  const relay = (await p.fake.call('settings:get', {})).network.relay
  t.is(relay.publicKey, relayKey)
  t.is(relay.kind, 'open')
  t.is(relay.label, ACME.name)
  await p.fake.call('network:set-relay', { lastTest: { at: 5, ok: true } })
  t.alike((await p.fake.call('settings:get', {})).network.relay.lastTest, { at: 5, ok: true })
  t.is(JSON.parse(fs.readFileSync(path.join(path.dirname(p.storage), 'settings.json'), 'utf8')).network.relay, null, 'nothing stored as the person\'s slot')
})

test('a newer bundle over HTTPS updates the overlay; an older one is refused', async (t) => {
  const p = await setup(t)
  const now = Math.floor(Date.now() / 1000)
  p.serve(LOCKS, { issuedAt: now })
  await p.fake.call('managed:accept', { code: p.org.code })
  p.serve({ ...LOCKS, 'audit.retentionDays': 365 }, { issuedAt: now + 10 })
  await waitFor(() => getAuditConfig().retentionDays === 365, 8000, { label: 'the newer retention' })
  await waitFor(async () => (await queryAudit({ kinds: ['managed.changed'], limit: 1 })).entries.length === 1, 5000, { label: 'a managed.changed row' })
  p.serve({ ...LOCKS, 'audit.retentionDays': 30 }, { issuedAt: now + 5 })
  const before = p.api.requests.length
  await waitFor(() => p.api.requests.length > before + 1, 8000, { label: 'two more polls' })
  t.is(getAuditConfig().retentionDays, 365, 'a bundle older than the last applied is never applied')
})

test('leave returns the install to its own settings and removes everything', async (t) => {
  const p = await setup(t)
  await p.fake.call('audit:configure', { enabled: false })
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  const left = await p.fake.call('managed:leave', {})
  t.alike(left, { left: ACME.name })
  t.is(getManagedOverlay(), null)
  t.is(getRelayConfig().mode, 'off')
  t.is(getAuditConfig().enabled, false)
  t.absent(p.exists('managed.enc'))
  t.absent(p.exists('managed-store'))
  t.is(await p.fake.call('managed:get', {}), null)
  t.alike(p.root.managed.health().detail.state, 'unmanaged')
  t.is(p.root.managed.timers.size, 0, 'no poll left armed')
})

test('a restart applies the stored configuration at boot, offline', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await p.api.close()
  const again = await rebootPeer(t, p)
  wire(again)
  t.is(getRelayConfig().mode, 'always', 'the overlay is applied before any request')
  t.is(getAuditConfig().retentionDays, 90)
  t.is((await again.fake.call('managed:get', {})).organization.name, ACME.name)
})

test('purging the Activity Log keeps the person\'s own config, never the organization\'s', async (t) => {
  const p = await setup(t)
  await p.fake.call('audit:configure', { enabled: false, retentionDays: 30 })
  p.serve({ 'audit.retentionDays': 90 })
  await p.fake.call('managed:accept', { code: p.org.code })
  await p.fake.call('audit:purge', {})
  t.alike({ enabled: getStoredAuditConfig().enabled, retentionDays: getStoredAuditConfig().retentionDays }, { enabled: false, retentionDays: 30 })
})

test('a second organization replaces the first', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  const other = organization({ apiUrl: p.api.apiUrl })
  p.api.set({ bundles: [{ profileId: 'p2', bytes: sealBundle({ signer: SIGNER, driveKey: other.driveKey, recipients: [other.bundlePublicKey], organization: { name: 'Beta AG' }, apiUrl: p.api.apiUrl, settings: { 'network.relayMode': 'auto' } }) }] })
  const preview = await p.fake.call('managed:preview', { code: other.code })
  t.is(preview.replaces, ACME.name)
  const view = await p.fake.call('managed:accept', { code: other.code })
  t.is(view.organization.name, 'Beta AG')
  t.is(getRelayConfig().mode, 'auto')
  t.is(getAuditConfig().enabled, getStoredAuditConfig().enabled, 'the first organization\'s locks are gone')
})

test('setting the identity aside moves the organization with it, and the next boot is unmanaged', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await p.root.close()
  const folder = setAsideLockedData(p.storage)
  t.ok(fs.existsSync(path.join(folder, 'managed.enc')), 'managed.enc moved with the identity files')
  t.absent(p.exists('managed.enc'))
})

test('REGRESSION (FIX-2: replace leaves no trace): replacing an organization records that the first was left', async (t) => {
  const p = await setup(t)
  await p.fake.call('audit:configure', { enabled: true })
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  const other = organization({ apiUrl: p.api.apiUrl })
  p.api.set({ bundles: [{ profileId: 'p2', bytes: sealBundle({ signer: SIGNER, driveKey: other.driveKey, recipients: [other.bundlePublicKey], organization: { name: 'Beta AG' }, apiUrl: p.api.apiUrl, settings: { 'network.relayMode': 'auto' } }) }] })
  await p.fake.call('managed:accept', { code: other.code })
  const kinds = async () => (await queryAudit({ kinds: ['managed.joined', 'managed.left'], limit: 10 })).entries.map((e) => e.kind).sort()
  await waitFor(async () => (await kinds()).length >= 3, 5000, { label: 'three rows' }).catch(() => {})
  t.alike(await kinds(), ['managed.joined', 'managed.joined', 'managed.left'])
})

test('REGRESSION (FIX-3: rollback floor): accepting the same drive again never applies an older configuration', async (t) => {
  const p = await setup(t)
  const now = Math.floor(Date.now() / 1000)
  p.serve({ ...LOCKS, 'audit.retentionDays': 365 }, { issuedAt: now + 10 })
  await p.fake.call('managed:accept', { code: p.org.code })
  p.serve(LOCKS, { issuedAt: now })
  await p.fake.call('managed:accept', { code: p.org.code })
  t.is(getAuditConfig().retentionDays, 365, 'the newer configuration stays applied')
})

test('REGRESSION (FIX-4: purge under a recording lock): the Activity Log cannot be deleted while the organization keeps recording on', async (t) => {
  const p = await setup(t)
  await p.fake.call('audit:configure', { enabled: true })
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(async () => (await p.fake.call('audit:stats', {})).count > 0, 5000, { label: 'a recorded row' })
  const before = (await p.fake.call('audit:stats', {})).count
  await t.exception(p.fake.call('audit:purge', {}), /set by your organization/)
  t.is((await p.fake.call('audit:stats', {})).count, before, 'every row is kept')
  await p.fake.call('managed:leave', {})
  t.ok((await p.fake.call('audit:purge', {})).purged > 0, 'leaving the organization allows it again')
})

test('the Activity Log can be deleted while the organization keeps recording off', async (t) => {
  const p = await setup(t)
  p.serve({ 'audit.enabled': false })
  await p.fake.call('managed:accept', { code: p.org.code })
  await t.execution(p.fake.call('audit:purge', {}))
})
