import test from 'brittle'
import { passphraseVerdict } from '../../src/renderer/model/recovery-passphrase.js'
import { RECOVERY_PASSPHRASE_MIN, isLongEnoughPassphrase } from '../../src/shared/contract/recovery-key.js'

test('a passphrase is at least ten characters, counted as the user sees them', (t) => {
  t.is(RECOVERY_PASSPHRASE_MIN, 10)
  t.absent(isLongEnoughPassphrase('123456789'))
  t.ok(isLongEnoughPassphrase('1234567890'))
  t.absent(isLongEnoughPassphrase('🔑'.repeat(9)), 'nine emoji, eighteen UTF-16 units')
  t.ok(isLongEnoughPassphrase('🔑'.repeat(10)))
})

test('the backup dialog saves only a long enough passphrase typed twice', (t) => {
  t.is(passphraseVerdict('short', 'short'), 'too-short')
  t.is(passphraseVerdict('long enough one', 'long enough two'), 'mismatch')
  t.is(passphraseVerdict('long enough one', 'long enough one'), 'ok')
  t.is(passphraseVerdict('', ''), 'too-short', 'nothing typed yet')
})
