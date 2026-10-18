import test from 'brittle'
import b4a from 'b4a'
import c from 'compact-encoding'
import sodium from 'sodium-native'
import vectors from '../fixtures/managed/drive-entry-v1.json' with { type: 'json' }
import { BUNDLES_SUB, decodeDriveEntry } from '../../src/shared/managed/drive-entry.js'

const hex = (s) => b4a.from(s, 'hex')
const sha256 = (buf) => {
  const out = b4a.alloc(32)
  sodium.crypto_hash_sha256(out, buf)
  return b4a.toString(out, 'hex')
}

function generate(g) {
  const state = c.state()
  const bundle = b4a.alloc(g.bundleBytes, g.fill)
  c.uint.preencode(state, 1)
  c.uint.preencode(state, g.seq)
  c.fixed32.preencode(state, hex(g.payloadSha256))
  c.string.preencode(state, g.profileVersionId)
  c.uint.preencode(state, g.issuedAt)
  c.buffer.preencode(state, bundle)
  state.buffer = b4a.alloc(state.end)
  c.uint.encode(state, 1)
  c.uint.encode(state, g.seq)
  c.fixed32.encode(state, hex(g.payloadSha256))
  c.string.encode(state, g.profileVersionId)
  c.uint.encode(state, g.issuedAt)
  c.buffer.encode(state, bundle)
  return state.buffer
}

test('the sub and the raw key', (t) => {
  t.is(vectors.sub, BUNDLES_SUB)
  for (const v of vectors.valid) t.is(v.rawKeyHex, b4a.toString(b4a.from(`${BUNDLES_SUB}\0${v.profileId}`), 'hex'), v.name)
})

test('every valid entry decodes to its fields', (t) => {
  for (const v of vectors.valid) {
    const value = v.generator ? generate(v.generator) : hex(v.valueHex)
    if (v.valueSha256) t.is(sha256(value), v.valueSha256, `${v.name}: generator`)
    const entry = decodeDriveEntry(value)
    t.ok(entry, v.name)
    const want = v.entry ?? { seq: v.generator.seq, payloadSha256: v.generator.payloadSha256, profileVersionId: v.generator.profileVersionId, issuedAt: v.generator.issuedAt }
    t.is(entry.seq, want.seq, v.name)
    t.is(b4a.toString(entry.payloadSha256, 'hex'), want.payloadSha256, v.name)
    t.is(entry.profileVersionId, want.profileVersionId, v.name)
    t.is(entry.issuedAt, want.issuedAt, v.name)
    if (v.entry) t.is(b4a.toString(entry.bundle, 'hex'), v.entry.bundleHex, v.name)
    else t.is(entry.bundle.byteLength, v.generator.bundleBytes, v.name)
  }
})

test('every invalid entry is null', (t) => {
  for (const v of vectors.invalid) t.is(decodeDriveEntry(v.generator ? generate(v.generator) : hex(v.valueHex)), null, v.name)
  t.is(decodeDriveEntry(null), null)
})
