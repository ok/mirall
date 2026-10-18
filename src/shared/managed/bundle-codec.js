// The decode half of the Console's bundle envelope v1 (packages/core/publication/bundle.ts):
// header, signature, one sealed content key per license key, nonce, ciphertext. Trailing bytes and
// over-cap counts are refused; compact-encoding checks neither itself.
import c from 'compact-encoding'
import b4a from 'b4a'

export const MAGIC = b4a.from('MRLB')
export const FORMAT_VERSION = 1
export const MAX_BUNDLE_BYTES = 1024 * 1024
const SIGNING_KEY_ID_BYTES = 8
const SEALED_CEK_BYTES = 32 + 48
const NONCE_BYTES = 24
const MAX_WRAPS = 16_384
const MAX_EXTENSIONS = 64

function list(state, max, decodeItem) {
  const length = c.uint.decode(state)
  if (length > max) throw new Error('too many entries')
  const out = []
  for (let i = 0; i < length; i++) out.push(decodeItem(state))
  return out
}

function exactly(bytes, decodeAll) {
  const state = c.state(0, bytes.byteLength, bytes)
  const value = decodeAll(state)
  if (state.start !== state.end) throw new Error('trailing bytes')
  return value
}

export function decodeHeader(bytes) {
  return exactly(bytes, (state) => ({
    magic: c.fixed(4).decode(state),
    formatVersion: c.uint.decode(state),
    flags: c.uint.decode(state),
    signingKeyId: c.fixed(SIGNING_KEY_ID_BYTES).decode(state),
    driveKey: c.fixed32.decode(state),
    issuedAt: c.uint.decode(state),
    profileVersionId: c.fixed(16).decode(state),
    catalogVersion: c.uint.decode(state),
    docHash: c.fixed32.decode(state),
    extensions: list(state, MAX_EXTENSIONS, (s) => ({ type: c.uint.decode(s), critical: c.bool.decode(s), value: c.uint8array.decode(s) })),
  }))
}

export function decodeBundle(bytes) {
  return exactly(bytes, (state) => ({
    header: c.uint8array.decode(state),
    signature: c.fixed64.decode(state),
    wraps: list(state, MAX_WRAPS, (s) => ({ keyHint: c.fixed(8).decode(s), sealedCek: c.fixed(SEALED_CEK_BYTES).decode(s) })),
    nonce: c.fixed(NONCE_BYTES).decode(state),
    ciphertext: c.uint8array.decode(state),
  }))
}
