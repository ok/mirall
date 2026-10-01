// The recovery key file's public face, read by the worker that opens it and the window that shows
// which key was chosen: its type and version, and a passphrase rule of at least this many characters,
// counted as the user sees them (code points), not as UTF-16 units.
export const RECOVERY_FILE_TYPE = 'mirall-recovery-key'
export const RECOVERY_FILE_VERSION = 1
export const RECOVERY_PASSPHRASE_MIN = 10

/** @param {string} passphrase @returns {boolean} */
export function isLongEnoughPassphrase(passphrase) {
  return [...passphrase].length >= RECOVERY_PASSPHRASE_MIN
}

/**
 * The header of a recovery key file, or null for text that is not one this build reads. Only the
 * clear-text header: whether the passphrase opens it is the worker's to say.
 * @param {string} text
 * @returns {{ identityPub: string, createdAt: string } | null}
 */
export function readRecoveryHeader(text) {
  /** @type {{ type?: string, v?: number, identityPub?: string, createdAt?: string } | null} */
  let file
  try {
    file = JSON.parse(text)
  } catch {
    return null
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) return null
  if (file.type !== RECOVERY_FILE_TYPE || file.v !== RECOVERY_FILE_VERSION) return null
  if (typeof file.identityPub !== 'string' || typeof file.createdAt !== 'string') return null
  return { identityPub: file.identityPub, createdAt: file.createdAt }
}
