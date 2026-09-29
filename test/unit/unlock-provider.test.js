import test from 'brittle'
import b4a from 'b4a'
import { osKeychainProvider, unlockProviderFor, OS_KEYCHAIN } from '../../src/shared/core/unlock-provider.js'
import { CODES } from '../../src/shared/contract/errors.js'

const KEK_HEX = 'ab'.repeat(32)

test('the os-keychain provider names itself and yields the host KEK', async (t) => {
  const provider = osKeychainProvider(KEK_HEX)
  t.is(provider.name, OS_KEYCHAIN)
  t.is(OS_KEYCHAIN, 'os-keychain', 'the name is sealed into identity.enc, so its spelling is fixed')
  t.alike(await provider.getKEK(), b4a.from(KEK_HEX, 'hex'))
})

test('a bootstrap with a KEK unlocks through the os-keychain provider', async (t) => {
  const provider = unlockProviderFor({ identityKEK: KEK_HEX })
  t.is(provider.name, OS_KEYCHAIN)
  t.alike(await provider.getKEK(), b4a.from(KEK_HEX, 'hex'))
})

test('REGRESSION (P2.2c: a bootstrap without a KEK booted with no identity)', (t) => {
  const malformed = ['deadbeef', 'zz'.repeat(32), KEK_HEX.toUpperCase(), KEK_HEX + '00']
  for (const bootstrap of [{}, { identityKEK: null }, { identityKEK: '' }, ...malformed.map((identityKEK) => ({ identityKEK }))]) {
    try {
      unlockProviderFor(bootstrap)
      t.fail(`accepted ${JSON.stringify(bootstrap)}`)
    } catch (err) {
      t.is(err.code, CODES.IDENTITY_NO_KEK, `refused ${JSON.stringify(bootstrap)}`)
    }
  }
})
