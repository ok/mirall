import b4a from 'b4a'

// An unlock provider yields the KEK that unwraps identity.enc; getKEK() returns a
// 32-byte Buffer or null. The host supplies the KEK (Electron main's safeStorage by
// default) — the data layer never imports Electron. Other providers
// (passphrase/platform-bind/file/TPM) slot in behind the same shape.
export function osKeychainProvider(kekHex) {
  const kek = kekHex ? b4a.from(kekHex, 'hex') : null
  return { name: 'os-keychain', getKEK: () => kek }
}
