// What the stopped-backup toast does as the backup status changes. It is raised when the backup turns
// stale (no success for ten days), naming the folder when that is the cause, and raised again only when
// the cause changes, so a toast the user dismissed stays dismissed. When it stops being stale, a folder
// that came back — the same folder, now backed up to — is said once; any other way out (another folder
// chosen, the backup turned off) just takes the toast away.

/** @typedef {'stale' | 'offline'} BackupToastCause */
/** @typedef {{ cause: BackupToastCause | null, folder: string | null }} BackupToastState */
/** @typedef {{ kind: 'show', cause: BackupToastCause } | { kind: 'dismiss' } | { kind: 'restored' }} BackupToastAction */

/**
 * @param {{ previous: BackupToastState | null, stale: boolean, offline: boolean, folder: string | null }} args
 * @returns {{ state: BackupToastState, action: BackupToastAction | null }}
 */
export function backupToastDecision({ previous, stale, offline, folder }) {
  /** @type {BackupToastCause | null} */
  const cause = stale ? (offline ? 'offline' : 'stale') : null
  const state = { cause, folder }
  const before = previous?.cause ?? null
  if (cause === before) return { state, action: null }
  if (cause) return { state, action: { kind: 'show', cause } }
  const cameBack = before === 'offline' && folder !== null && folder === previous?.folder
  return { state, action: { kind: cameBack ? 'restored' : 'dismiss' } }
}
