import b4a from 'b4a'
import { AppError } from './errors.js'
import { CODES } from '../contract/errors.js'

// An unlock provider yields the KEK that unwraps identity.enc: { name, getKEK() } where getKEK
// resolves a 32-byte Buffer or null. The name is sealed into the envelope and checked on every
// unlock, because a KEK from another provider is another secret. The host owns the key material, so
// the data layer never imports Electron. os-keychain (a KEK the host keeps in the OS keychain) is the
// one provider; a headless key file and a passphrase the worker waits for while locked fit the same
// shape.
export const OS_KEYCHAIN = 'os-keychain'

const KEK_HEX = /^[0-9a-f]{64}$/

// A missing or malformed KEK is a host fault, not a fresh install: booting on would run with no identity.
export function osKeychainProvider(kekHex) {
  if (typeof kekHex !== 'string' || !KEK_HEX.test(kekHex)) {
    throw new AppError(CODES.IDENTITY_NO_KEK, 'identity: the host supplied no usable unlock key')
  }
  const kek = b4a.from(kekHex, 'hex')
  return { name: OS_KEYCHAIN, getKEK: async () => kek }
}

export function unlockProviderFor(bootstrap) {
  return osKeychainProvider(bootstrap.identityKEK)
}
