import sodium from 'sodium-native'
import b4a from 'b4a'

// Anonymous sealed box for the SCK (space content key) carried in a membership:grant: the
// SCK is encrypted to the recipient's ed25519 signer key — the same key the handshake
// identity binding ties to its profileKey — converted to curve25519. Only the holder of the
// matching signer secret can open it, so a transport spoofer that captures the grant frame
// still cannot read the SCK, independently of the handshake-binding flag.
export function sealSck(sckBuf, recipientSignerPkEd) {
  const xpk = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(xpk, recipientSignerPkEd)
  const ct = b4a.alloc(sckBuf.length + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(ct, sckBuf, xpk)
  return ct
}

export function openSealedSck(ct, ownSignerEd) {
  if (ct.length < sodium.crypto_box_SEALBYTES) return null
  const xpk = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const xsk = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(xpk, ownSignerEd.publicKey)
  sodium.crypto_sign_ed25519_sk_to_curve25519(xsk, ownSignerEd.secretKey)
  const out = b4a.alloc(ct.length - sodium.crypto_box_SEALBYTES)
  if (!sodium.crypto_box_seal_open(out, ct, xpk, xsk)) return null
  return out
}
