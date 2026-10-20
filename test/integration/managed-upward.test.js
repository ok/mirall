import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { freshPeer, rebootPeer } from '../helpers/store.js'
import { waitFor } from '../helpers/bare-poll.js'
import { startManagedConsole } from '../helpers/managed-console.js'
import { signer, organization, sealBundle } from '../helpers/managed-seal.js'
import { registerManaged } from '../../src/worker/ipc/managed.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { enrollKeyPair } from '../../src/shared/managed/derive.js'
import { setAsideLockedData } from '../../src/shared/core/identity-set-aside.js'

const SIGNER = signer()
const ACME = { name: 'Acme Test GmbH' }
const LOCKS = { 'network.relayMode': 'always', 'audit.enabled': true }

function wire(peer) {
  registerManaged(peer.fake.ipc, { service: peer.root.managed })
  setRuntimeConfig({ ...getRuntimeConfig(), managedTestSigningKey: SIGNER.publicHex, managedAllowHttpLoopback: true, managedPreviewTimeoutMs: 1500, managedHttpsPollMs: 60_000, managedReportDelayMs: 0 })
}

async function setup(t) {
  const peer = await freshPeer(t)
  wire(peer)
  const api = await startManagedConsole(t)
  const org = organization({ apiUrl: api.apiUrl })
  const serve = (settings, { issuedAt, target = org } = {}) => api.set({
    bundles: [{ profileId: 'p1', bytes: sealBundle({ signer: SIGNER, driveKey: target.driveKey, recipients: [target.bundlePublicKey], organization: ACME, apiUrl: api.apiUrl, settings, issuedAt }) }],
  })
  const keyFile = path.join(path.dirname(peer.storage), 'instance-key.json')
  const reports = () => api.upward.map((u) => u.body.report ?? u.body)
  return { ...peer, api, org, serve, keyFile, reports }
}

const enrollHex = (org) => b4a.toString(enrollKeyPair(org.licenseKey).publicKey, 'hex')

test('connect enrolls a new instance key with the license, signed, and keeps the key machine-only', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  const before = Date.now()
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(() => p.api.upward.length >= 1, 5000, { label: 'the enrollment' })
  const [enroll] = p.api.upward
  t.is(enroll.call, 'instance-enroll')
  t.ok(enroll.signed, 'the instance key signed the request')
  t.ok(enroll.enrolled, 'the license\'s key signed the enrollment')
  t.is(enroll.body.enrollPublicKey, enrollHex(p.org))
  t.absent(JSON.stringify(enroll.body).includes(b4a.toString(p.org.licenseKey, 'hex')), 'the license key is never sent')
  const report = enroll.body.report
  t.is(report.state, 'managed')
  t.ok(['macos', 'windows', 'linux'].includes(report.platform))
  t.is(report.channel, 'dev')
  t.is(report.reportCounter, 1)
  t.absent(report.hostnameLabel.includes('.'), 'the short computer name')
  t.ok(report.applied.issuedAt >= Math.floor(before / 1000) * 1000 - 1000, 'issuedAt in milliseconds')
  t.is(report.applied.via, 'https')
  t.alike(report.refusedKeys, [])
  t.ok(Math.abs(enroll.timestamp - Date.now() / 1000) < 60, 'the header timestamp is unix seconds')
  const stored = JSON.parse(fs.readFileSync(p.keyFile, 'utf8'))
  t.is(stored.enrollPublicKey, enrollHex(p.org))
  t.is(stored.enrolled, true)
  t.is(fs.statSync(p.keyFile).mode & 0o777, 0o600)
  t.is((await p.fake.call('managed:get', {})).revoked, false)
})

test('a newly applied configuration is reported with a higher counter, refused keys included', async (t) => {
  const p = await setup(t)
  const now = Math.floor(Date.now() / 1000)
  p.serve(LOCKS, { issuedAt: now })
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(() => p.api.upward.length >= 1, 5000, { label: 'the enrollment' })
  p.serve({ ...LOCKS, 'audit.retentionDays': 7 }, { issuedAt: now + 10 })
  await p.root.managed.refreshHttps()
  await waitFor(() => p.api.upward.length >= 2, 8000, { label: 'the change report' })
  const change = p.api.upward[1]
  t.is(change.call, 'instance-report')
  t.ok(change.signed)
  t.is(change.instanceKey, p.api.upward[0].instanceKey, 'the same instance key')
  t.ok(change.body.reportCounter > p.api.upward[0].body.report.reportCounter)
  t.alike(change.body.refusedKeys, ['audit.retentionDays'], 'a value this build refuses is reported by key, never by value')
  t.is(change.body.applied.issuedAt, (now + 10) * 1000)
})

test('leave tells the organization first, then removes the configuration and the key', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(() => p.api.upward.length >= 1, 5000, { label: 'the enrollment' })
  t.alike(await p.fake.call('managed:leave', {}), { left: ACME.name })
  const last = p.api.upward.at(-1)
  t.is(last.call, 'instance-report')
  t.is(last.body.state, 'left')
  t.ok(last.signed)
  t.absent(fs.existsSync(p.keyFile), 'the instance key is deleted')
  t.absent(fs.existsSync(path.join(path.dirname(p.storage), 'managed.enc')))
  t.is(p.root.managed.timers.size, 0, 'nothing left armed')
})

test('leave goes ahead while the Console is unreachable', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(() => p.api.upward.length >= 1, 5000, { label: 'the enrollment' })
  await p.api.close()
  t.alike(await p.fake.call('managed:leave', {}), { left: ACME.name })
  t.absent(fs.existsSync(p.keyFile))
  t.is(await p.fake.call('managed:get', {}), null)
})

test('a revoked license shows as revoked, stops reporting and keeps the configuration', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  p.api.answer(() => ({ status: 410, body: { error: 'revoked' } }))
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(async () => (await p.fake.call('managed:get', {})).revoked, 5000, { label: 'revoked' })
  const view = await p.fake.call('managed:get', {})
  t.is(view.organization.name, ACME.name, 'still managed')
  t.ok(view.locked.includes('network.relayMode'), 'the configuration stays applied')
  t.ok(p.fake.emitted('event:reconcile').some((e) => e.payload.scope.kind === 'managed'))
  const sent = p.api.upward.length
  p.root.managed.reporter.changed()
  await new Promise((resolve) => setTimeout(resolve, 2500))
  t.is(p.api.upward.length, sent, 'no report after the revocation')
  await p.fake.call('managed:leave', {})
  t.is(p.api.upward.length, sent, 'and no left report either')
})

test('a key the Console does not know enrolls again, with the same key', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(() => p.api.upward.length >= 1, 5000, { label: 'the enrollment' })
  let once = true
  p.api.answer((entry) => {
    if (entry.call === 'instance-report' && once) {
      once = false
      return { status: 401, body: { error: 'unknown_instance' } }
    }
    return { status: 200, body: {} }
  })
  p.root.managed.reporter.changed()
  await waitFor(() => p.api.upward.length >= 3, 8000, { label: 'the report and the enrollment' })
  const [first, report, again] = p.api.upward
  t.is(report.call, 'instance-report')
  t.is(again.call, 'instance-enroll')
  t.is(again.instanceKey, first.instanceKey)
  t.ok(again.body.report.reportCounter > report.body.reportCounter, 'a retry carries a higher counter')
})

test('a wrong clock is corrected from the Console\'s time and tried once more', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  const serverTime = Math.floor(Date.now() / 1000) + 3600
  let once = true
  p.api.answer(() => {
    if (once) {
      once = false
      return { status: 401, body: { error: 'clock_skew', serverTime } }
    }
    return { status: 200, body: {} }
  })
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(() => p.api.upward.length >= 2, 5000, { label: 'the retry' })
  const [skewed, retried] = p.api.upward
  t.ok(Math.abs(retried.timestamp - serverTime) < 60, 'the retry carries the Console\'s time')
  t.not(retried.nonce, skewed.nonce, 'with a fresh nonce')
  t.ok(retried.body.report.reportCounter > skewed.body.report.reportCounter)
})

test('replacing the organization tells the first one this computer left, then enrolls a new key', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(() => p.api.upward.length >= 1, 5000, { label: 'the first enrollment' })
  const first = p.api.upward[0]
  const other = organization({ apiUrl: p.api.apiUrl })
  p.serve({ 'network.relayMode': 'auto' }, { target: other })
  await p.fake.call('managed:accept', { code: other.code })
  await waitFor(() => p.api.upward.some((u) => u.call === 'instance-enroll' && u.body.enrollPublicKey === enrollHex(other)), 5000, { label: 'the second enrollment' })
  const left = p.api.upward.find((u) => u.body.state === 'left')
  t.is(left.instanceKey, first.instanceKey, 'the first organization hears from its own key')
  const second = p.api.upward.find((u) => u.body.enrollPublicKey === enrollHex(other))
  t.not(second.instanceKey, first.instanceKey, 'a new key for the new license')
  t.is(second.body.report.reportCounter, 1)
})

test('a restart keeps the instance key and its counter', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(() => p.api.upward.length >= 1, 5000, { label: 'the enrollment' })
  const first = p.api.upward[0]
  const again = await rebootPeer(t, p)
  wire(again)
  again.root.managed.reporter.changed()
  await waitFor(() => p.api.upward.length >= 2, 8000, { label: 'a report after the restart' })
  const next = p.api.upward.at(-1)
  t.is(next.call, 'instance-report', 'already enrolled')
  t.is(next.instanceKey, first.instanceKey)
  t.ok(next.body.reportCounter > first.body.report.reportCounter)
})

test('setting the identity aside leaves the instance key on this computer', async (t) => {
  const p = await setup(t)
  p.serve(LOCKS)
  await p.fake.call('managed:accept', { code: p.org.code })
  await waitFor(() => fs.existsSync(p.keyFile), 5000, { label: 'the key file' })
  await p.root.close()
  const folder = setAsideLockedData(p.storage)
  t.ok(fs.existsSync(p.keyFile), 'the key stays')
  t.absent(fs.existsSync(path.join(folder, 'instance-key.json')))
})
