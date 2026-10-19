// Builds organization bundles and activation codes the way the Console and the publisher do, so a
// test drives the app's real verify path. Runs under Node and Bare alike.
import sodium from 'sodium-native'
import c from 'compact-encoding'
import b4a from 'b4a'
import { bundleKeyPair, keyHint } from '../../src/shared/managed/derive.js'
import { encodeActivationCode } from '../../src/shared/managed/activation-link.js'

const random = (n) => {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

export function signer(seed = random(32)) {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  return { publicKey, secretKey, publicHex: b4a.toString(publicKey, 'hex') }
}

// One organization: its drive key and one license key whose activation code points at `apiUrl`.
export function organization({ apiUrl, licenseKey = random(15), driveKey = random(32) } = {}) {
  const pair = bundleKeyPair(licenseKey)
  return {
    licenseKey,
    driveKey,
    bundlePublicKey: pair.publicKey,
    hint: b4a.toString(keyHint(pair.publicKey), 'hex'),
    code: encodeActivationCode({ licenseKey, driveKey, apiUrl }),
  }
}

function encodeHeader(h) {
  const state = c.state()
  const fields = (fn) => {
    fn(c.fixed(4), b4a.from('MRLB'))
    fn(c.uint, 1)
    fn(c.uint, 0)
    fn(c.fixed(8), h.signingKeyId)
    fn(c.fixed32, h.driveKey)
    fn(c.uint, h.issuedAt)
    fn(c.fixed(16), h.profileVersionId)
    fn(c.uint, 1)
    fn(c.fixed32, h.docHash)
    fn(c.uint, 0)
  }
  fields((enc, v) => enc.preencode(state, v))
  state.buffer = b4a.alloc(state.end)
  fields((enc, v) => enc.encode(state, v))
  return state.buffer
}

function encodeBundle(b) {
  const state = c.state()
  const fields = (fn) => {
    fn(c.uint8array, b.header)
    fn(c.fixed64, b.signature)
    fn(c.uint, b.wraps.length)
    for (const w of b.wraps) {
      fn(c.fixed(8), w.keyHint)
      fn(c.fixed(80), w.sealedCek)
    }
    fn(c.fixed(24), b.nonce)
    fn(c.uint8array, b.ciphertext)
  }
  fields((enc, v) => enc.preencode(state, v))
  state.buffer = b4a.alloc(state.end)
  fields((enc, v) => enc.encode(state, v))
  return state.buffer
}

// A sealed bundle for the given recipients. `settings` maps a key to its plain value, locked.
export function sealBundle({ signer: s, driveKey, recipients, organization: org, apiUrl, settings, issuedAt = Math.floor(Date.now() / 1000), profileVersionId = random(16) }) {
  const doc = b4a.from(JSON.stringify({
    catalogVersion: 1,
    organization: org,
    endpoints: { apiUrl },
    settings: Object.fromEntries(Object.entries(settings).map(([k, value]) => [k, { value, locked: true }])),
  }))
  const docHash = b4a.alloc(32)
  sodium.crypto_hash_sha256(docHash, doc)
  const header = encodeHeader({ signingKeyId: s.publicKey.subarray(0, 8), driveKey, issuedAt, profileVersionId, docHash })
  const signature = b4a.alloc(64)
  sodium.crypto_sign_detached(signature, header, s.secretKey)
  const cek = random(32)
  const nonce = random(24)
  const wraps = recipients.map((pk) => {
    const sealedCek = b4a.alloc(80)
    sodium.crypto_box_seal(sealedCek, cek, pk)
    return { keyHint: keyHint(pk), sealedCek }
  })
  const ciphertext = b4a.alloc(doc.byteLength + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, doc, header, null, nonce, cek)
  return encodeBundle({ header, signature, wraps, nonce, ciphertext })
}

// The publisher's DriveEntry v1 around a bundle.
export function encodeDriveEntry({ seq = 1, issuedAt, profileVersionId = '11111111-2222-4333-8444-555555555555', bundle }) {
  const sha = b4a.alloc(32)
  sodium.crypto_hash_sha256(sha, bundle)
  const state = c.state()
  const fields = (fn) => {
    fn(c.uint, 1)
    fn(c.uint, seq)
    fn(c.fixed32, sha)
    fn(c.string, profileVersionId)
    fn(c.uint, issuedAt)
    fn(c.buffer, bundle)
  }
  fields((enc, v) => enc.preencode(state, v))
  state.buffer = b4a.alloc(state.end)
  fields((enc, v) => enc.encode(state, v))
  return state.buffer
}
