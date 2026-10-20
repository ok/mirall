import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-native'
import Ajv2020 from 'ajv/dist/2020.js'
import vectors from '../fixtures/managed/upward-v1.json' with { type: 'json' }
import schema from '../fixtures/managed/upward-v1.schema.json' with { type: 'json' }
import bundleVectors from '../fixtures/managed/bundle-v1.json' with { type: 'json' }
import { enrollKeyPair } from '../../src/shared/managed/derive.js'
import { CALL, enrollBody, enrollmentMessage, hostnameLabel, instanceKeyPair, osVersionLabel, reportBody, requestMessage, signedHeaders } from '../../src/shared/managed/upward.js'

const hex = (buf) => b4a.toString(buf, 'hex')
const bytes = (s) => b4a.from(s, 'hex')
const ajv = new Ajv2020({ allErrors: true, strict: false })
ajv.addSchema(schema, 'upward')
const validator = (call) => ajv.getSchema(`upward#/$defs/${call}`)
const keyPair = instanceKeyPair(bytes(vectors.keys.instanceSeed))
const enrollKeys = enrollKeyPair(bytes(bundleVectors.derivation.licenseKeyBytes))

test('the instance and enrollment keys are the pinned ones', (t) => {
  t.is(hex(keyPair.publicKey), vectors.keys.instancePublicKey)
  t.is(hex(enrollKeys.publicKey), vectors.keys.enrollPublicKey)
})

test('every signed request is reproduced byte for byte', (t) => {
  for (const r of vectors.requests) {
    const body = b4a.from(r.body)
    const nonce = bytes(r.nonce)
    t.is(hex(requestMessage({ call: r.call, instanceKey: keyPair.publicKey, timestamp: r.timestamp, nonce, body })), r.message, `${r.name}: message`)
    const headers = signedHeaders({ call: r.call, keyPair, timestamp: r.timestamp, nonce, body })
    t.alike(headers, {
      'content-type': 'application/json',
      'x-mirall-instance-key': r.instanceKey,
      'x-mirall-timestamp': String(r.timestamp),
      'x-mirall-nonce': r.nonce,
      'x-mirall-signature': r.signature,
    }, `${r.name}: headers`)
    if (!r.enrollSignature) continue
    t.is(hex(enrollmentMessage({ instanceKey: keyPair.publicKey, timestamp: r.timestamp, nonce })), r.enrollmentMessage, `${r.name}: enrollment message`)
    const enroll = enrollBody({ enrollKeys, instanceKey: keyPair.publicKey, timestamp: r.timestamp, nonce, report: JSON.parse(r.body).report })
    t.alike(enroll, JSON.parse(r.body), `${r.name}: enroll body`)
  }
})

test('a request signed off the contract does not verify against the message the app builds', (t) => {
  for (const n of vectors.negative) {
    const message = requestMessage({ call: n.call, instanceKey: bytes(vectors.keys.instancePublicKey), timestamp: n.timestamp, nonce: bytes(n.nonce), body: b4a.from(n.body) })
    t.absent(sodium.crypto_sign_verify_detached(bytes(n.signature), message, bytes(vectors.keys.instancePublicKey)), n.name)
  }
  const enroll = vectors.requests.find((r) => r.call === CALL.ENROLL)
  for (const n of vectors.enrollmentNegative) {
    const message = enrollmentMessage({ instanceKey: keyPair.publicKey, timestamp: enroll.timestamp, nonce: bytes(enroll.nonce) })
    t.absent(sodium.crypto_sign_verify_detached(bytes(n.enrollSignature), message, bytes(n.enrollPublicKey)), n.name)
  }
})

test('the app\'s copy of the schema accepts every valid body and refuses every invalid one', (t) => {
  for (const v of vectors.bodies.valid) t.ok(validator(v.call)(v.body), v.name)
  for (const v of vectors.bodies.invalid) {
    if (v.consoleOnly) continue
    t.absent(validator(v.call)(v.body), v.name)
  }
})

const FACTS = {
  appVersion: '1.14.0',
  channel: 'staging',
  platform: 'macos',
  osVersion: '25.0.0',
  hostname: 'Pats-MacBook-Pro.local',
  applied: { profileVersionId: '6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5', issuedAt: 1792252000000, appliedAt: 1792252060000, via: 'https' },
  refusedKeys: ['audit.enabled'],
  ignoredUnlocked: ['network.relayMode'],
  backup: { setUp: true, verdict: 'protected', lastSuccessAt: null, managedFolder: false, extra: 'never sent' },
  state: 'managed',
  reportCounter: 7,
  installId: 'never sent',
}

test('a report is built from the contract\'s fields only, and passes the schema', (t) => {
  const body = reportBody(FACTS)
  t.ok(validator(CALL.REPORT)(body), JSON.stringify(validator(CALL.REPORT).errors))
  t.is(body.hostnameLabel, 'Pats-MacBook-Pro', 'the domain suffix is dropped')
  t.absent('installId' in body)
  t.absent('extra' in body.backup)
  t.is(body.reportCounter, 7)
  t.ok(validator(CALL.ENROLL)({ ...enrollBody({ enrollKeys, instanceKey: keyPair.publicKey, timestamp: 1, nonce: b4a.alloc(16), report: body }) }))
})

test('a report without an applied bundle, backup or counter still passes the schema', (t) => {
  const body = reportBody({ ...FACTS, applied: null, backup: null, reportCounter: 0, state: 'left' })
  t.ok(validator(CALL.REPORT)(body))
  t.absent('backup' in body)
  t.absent('reportCounter' in body)
})

test('the computer name and OS release are cut to what the contract accepts', (t) => {
  t.is(hostnameLabel('host.corp.example.com'), 'host')
  t.is(hostnameLabel('a\u0007b\nc'), 'abc')
  t.is(hostnameLabel('Café'), 'Café', 'NFC')
  t.is(hostnameLabel('x'.repeat(80)).length, 64)
  t.is(hostnameLabel(''), 'unknown')
  t.is(osVersionLabel('10.0.22631'), '10.0.22631')
  t.is(osVersionLabel('6.8.0-45-generic'), '6.8.0-45-generic')
  t.is(osVersionLabel('Darwin 24'), 'Darwin-24')
  t.is(osVersionLabel(''), 'unknown')
  for (const name of ['host.corp', 'a\u0007b', 'x'.repeat(80), '']) {
    t.ok(validator(CALL.REPORT)(reportBody({ ...FACTS, hostname: name })), `hostname ${JSON.stringify(name)}`)
  }
})
