// What the backup dialog says about the passphrase pair, before anything is sent to the worker.
import { isLongEnoughPassphrase } from '../../shared/contract/recovery-key.js'

/** @typedef {'too-short' | 'mismatch' | 'ok'} PassphraseVerdict */

/** @param {string} passphrase @param {string} confirmation @returns {PassphraseVerdict} */
export function passphraseVerdict(passphrase, confirmation) {
  if (!isLongEnoughPassphrase(passphrase)) return 'too-short'
  return passphrase === confirmation ? 'ok' : 'mismatch'
}
