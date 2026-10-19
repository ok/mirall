import test from 'brittle'
import b4a from 'b4a'
import vectors from '../fixtures/managed/bundle-v1.json' with { type: 'json' }
import { verifyBundle } from '../../src/shared/managed/verify.js'
import { bundleKeyPair, keyHint } from '../../src/shared/managed/derive.js'

const hex = (s) => b4a.from(s, 'hex')
const d = vectors.derivation
const ctx = {
  pinnedKeys: vectors.context.pinnedKeys.map(hex),
  driveKey: hex(vectors.context.driveKey),
  lastIssuedAt: vectors.context.lastIssuedAt,
  catalogVersions: vectors.context.catalogVersions,
  knownExtensions: vectors.context.knownExtensions,
  knownSettings: new Set(vectors.context.knownSettings),
  bundleKeyPair: bundleKeyPair(hex(d.licenseKeyBytes)),
}
const lever = (v) => v.loopbackLever === true

test('the derivations equal the Console vector through sodium-native', (t) => {
  const pair = bundleKeyPair(hex(d.licenseKeyBytes))
  t.is(b4a.toString(pair.publicKey, 'hex'), d.bundlePublicKey)
  t.is(b4a.toString(pair.secretKey, 'hex'), d.bundlePrivateKey)
  t.is(b4a.toString(keyHint(pair.publicKey), 'hex'), d.keyHint)
})

test('every positive vector verifies to its organization, endpoints and settings', (t) => {
  for (const p of vectors.positives) {
    const r = verifyBundle(hex(p.bundle), { ...ctx, allowHttp: lever(p) })
    t.ok(r.ok, p.name)
    t.is(r.organization.name, p.organization.name, p.name)
    t.is(r.organization.supportUrl, p.organization.supportUrl ?? null, p.name)
    t.is(r.organization.supportEmail, p.organization.supportEmail ?? null, p.name)
    t.alike(r.endpoints, p.endpoints, p.name)
    t.alike(r.settings, p.settings, p.name)
  }
})

test('every negative vector fails with exactly its named failure', (t) => {
  for (const n of vectors.negatives) {
    const r = verifyBundle(hex(n.bundle), { ...ctx, lastIssuedAt: n.lastIssuedAt ?? ctx.lastIssuedAt, allowHttp: lever(n) })
    t.is(r.failure, n.failure, n.name)
  }
})

test('the loopback positive is malformed without the lever', (t) => {
  for (const p of vectors.positives.filter(lever)) t.is(verifyBundle(hex(p.bundle), ctx).failure, 'malformed', p.name)
})

test('rollback: equal issuedAt passes, one second later fails', (t) => {
  const p = vectors.positives[0]
  const issuedAt = verifyBundle(hex(p.bundle), ctx).header.issuedAt
  t.ok(verifyBundle(hex(p.bundle), { ...ctx, lastIssuedAt: issuedAt }).ok)
  t.is(verifyBundle(hex(p.bundle), { ...ctx, lastIssuedAt: issuedAt + 1 }).failure, 'rollback')
})

test('a bundle over 1 MiB is refused before parsing', (t) => {
  t.is(verifyBundle(b4a.alloc(1024 * 1024 + 1), ctx).failure, 'too_large')
})
