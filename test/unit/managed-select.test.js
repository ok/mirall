import test from 'brittle'
import b4a from 'b4a'
import vectors from '../fixtures/managed/bundle-v1.json' with { type: 'json' }
import { selectApplied } from '../../src/shared/managed/select.js'
import { bundleKeyPair } from '../../src/shared/managed/derive.js'
import { verifyBundle } from '../../src/shared/managed/verify.js'

const hex = (s) => b4a.from(s, 'hex')
const ctx = {
  pinnedKeys: vectors.context.pinnedKeys.map(hex),
  driveKey: hex(vectors.context.driveKey),
  lastIssuedAt: 0,
  catalogVersions: vectors.context.catalogVersions,
  knownExtensions: [],
  knownSettings: new Set(vectors.context.knownSettings),
  bundleKeyPair: bundleKeyPair(hex(vectors.derivation.licenseKeyBytes)),
}
const positive = (name) => vectors.positives.find((p) => p.name === name)
const negative = (name) => vectors.negatives.find((n) => n.name === name)
const candidate = (profileId, v) => ({ profileId, bytes: hex(v.bundle) })

test('the verified bundle applies its locked, accepted values as plain values', (t) => {
  const r = selectApplied([candidate('p1', positive('valid'))], ctx)
  t.alike(r.applied.settings, { 'audit.enabled': true, 'audit.retentionDays': 90, 'network.relayMode': 'always' })
  t.is(r.applied.organization.name, 'Acme GmbH')
  t.alike(r.applied.endpoints, { apiUrl: 'https://api.mirall.app' })
  t.alike(r.refused, [])
})

test('a refused value drops only its key', (t) => {
  const r = selectApplied([candidate('p1', positive('a retention the app refuses: not one of 30, 90 or 365 days'))], ctx)
  t.alike(r.refused, ['audit.retentionDays'])
  t.alike(r.applied.settings, { 'audit.enabled': true, 'network.relayMode': 'always' })
})

test('an unlocked entry is not applied and is reported', (t) => {
  const r = selectApplied([candidate('p1', positive('unlocked entry: verified, ignored by a v1 app'))], ctx)
  t.alike(r.ignoredUnlocked, ['network.relayMode'])
  t.absent('network.relayMode' in r.applied.settings)
})

test('another key\'s bundle is silent; a broken one is a failure; nothing verified is null', (t) => {
  const r = selectApplied([candidate('a', negative('no wrap for this key')), candidate('b', negative('signed for another drive'))], ctx)
  t.is(r.applied, null)
  t.alike(r.failures, [{ profileId: 'b', failure: 'wrong_drive' }])
})

test('the newest issuedAt wins, a tie goes to the lower profileId', (t) => {
  const a = positive('valid')
  const b = positive('organization with a name only')
  const issued = (v) => verifyBundle(hex(v.bundle), ctx).header.issuedAt
  const r = selectApplied([candidate('z', a), candidate('y', b)], ctx)
  if (issued(a) === issued(b)) t.is(r.applied.organization.name, b.organization.name, 'tie → lower profileId')
  else t.is(r.applied.issuedAt, Math.max(issued(a), issued(b)))
})
