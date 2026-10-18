// The Console's reference verifier (packages/core/publication/verify.ts), step for step and with the
// same failure names, so the Console's negative vectors pin each step here too.
import sodium from 'sodium-native'
import b4a from 'b4a'
import { decodeBundle, decodeHeader, FORMAT_VERSION, MAGIC, MAX_BUNDLE_BYTES } from './bundle-codec.js'
import { keyHint } from './derive.js'
import { parseDocument } from './document.js'

const CEK_BYTES = 32
const SIGNING_KEY_ID_BYTES = 8
const fail = (failure) => ({ ok: false, failure })

function openEnvelope(bytes) {
  if (bytes.byteLength > MAX_BUNDLE_BYTES) return { failure: 'too_large' }
  try {
    const bundle = decodeBundle(bytes)
    const header = decodeHeader(bundle.header)
    if (!b4a.equals(header.magic, MAGIC) || header.formatVersion !== FORMAT_VERSION || header.flags !== 0) return { failure: 'malformed' }
    return { bundle, header }
  } catch {
    return { failure: 'malformed' }
  }
}

function checkHeader(bundle, header, ctx) {
  const signer = ctx.pinnedKeys.find((key) => b4a.equals(key.subarray(0, SIGNING_KEY_ID_BYTES), header.signingKeyId))
  if (!signer) return 'unknown_signing_key'
  if (!sodium.crypto_sign_verify_detached(bundle.signature, bundle.header, signer)) return 'bad_signature'
  if (!b4a.equals(header.driveKey, ctx.driveKey)) return 'wrong_drive'
  if (header.issuedAt < ctx.lastIssuedAt) return 'rollback'
  if (!ctx.catalogVersions.includes(header.catalogVersion)) return 'unsupported'
  if (header.extensions.some((e) => e.critical && !ctx.knownExtensions.includes(e.type))) return 'unsupported'
  return null
}

function openContent(bundle, header, ctx) {
  const hint = keyHint(ctx.bundleKeyPair.publicKey)
  const wrap = bundle.wraps.find((w) => b4a.equals(w.keyHint, hint))
  if (!wrap) return 'not_for_this_key'
  const cek = b4a.alloc(CEK_BYTES)
  if (!sodium.crypto_box_seal_open(cek, wrap.sealedCek, ctx.bundleKeyPair.publicKey, ctx.bundleKeyPair.secretKey)) return 'undecryptable'
  const plaintext = b4a.alloc(Math.max(0, bundle.ciphertext.byteLength - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES))
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plaintext, null, bundle.ciphertext, bundle.header, bundle.nonce, cek)
  } catch {
    return 'undecryptable'
  } finally {
    sodium.sodium_memzero(cek)
  }
  const hash = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(hash, plaintext)
  return b4a.equals(hash, header.docHash) ? plaintext : 'doc_hash_mismatch'
}

export function verifyBundle(bytes, ctx) {
  const opened = openEnvelope(bytes)
  if (opened.failure) return fail(opened.failure)
  const refused = checkHeader(opened.bundle, opened.header, ctx)
  if (refused) return fail(refused)
  const plaintext = openContent(opened.bundle, opened.header, ctx)
  if (typeof plaintext === 'string') return fail(plaintext)
  const doc = parseDocument(plaintext, { allowHttp: ctx.allowHttp === true })
  if (!doc) return fail('malformed')
  const settings = {}
  for (const [key, setting] of Object.entries(doc.settings)) {
    if (ctx.knownSettings.has(key)) settings[key] = { value: setting.value, locked: setting.locked === true }
    else if (setting.critical === true) return fail('unknown_critical_setting')
  }
  return { ok: true, header: opened.header, organization: doc.organization, endpoints: doc.endpoints, settings }
}
