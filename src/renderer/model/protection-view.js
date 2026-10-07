// What the Backup screen and the Profile row say about a backup status, as copy keys and the one
// action that helps. Pure, so every cause maps to the same words wherever it is shown. The worker
// decides the verdict and its reason (prompt-rules.js); this only names them.

/** @import { BackupStatus } from '../../shared/contract/responses.js' */
/** @typedef {'protected' | 'at-risk' | 'stopped' | 'paused'} Lamp */
/** @typedef {'setup' | 'check' | 'new-key' | 'run' | null} Fix */

/** @type {Record<NonNullable<BackupStatus['verdictReason']>, { key: string, fix: Fix }>} */
const BY_REASON = {
  'not-set-up': { key: 'notSetUp', fix: 'setup' },
  'no-key': { key: 'noKey', fix: 'new-key' },
  stale: { key: 'stale', fix: 'run' },
  failing: { key: 'failing', fix: 'run' },
  'first-backup': { key: 'firstBackup', fix: 'run' },
  'key-not-in-folder': { key: 'keyNotInFolder', fix: 'run' },
  unconfirmed: { key: 'unconfirmed', fix: 'check' },
}

/** @param {BackupStatus} status @returns {Lamp | null} */
export function protectionLamp(status) {
  if (status.state === 'paused') return 'paused'
  return status.verdict
}

// A protected backup still offers Back up now: the banner is where the screen's one action lives.
/** @param {BackupStatus} status @returns {{ lamp: Lamp, key: string, fix: Fix } | null} */
export function protectionBanner(status) {
  const lamp = protectionLamp(status)
  if (!lamp) return null
  if (lamp === 'paused') return { lamp, key: 'paused', fix: null }
  if (!status.verdictReason) return { lamp, key: 'protected', fix: 'run' }
  return { lamp, ...BY_REASON[status.verdictReason] }
}

/** @param {BackupStatus} status @returns {{ key: string, at: number | null }} */
export function passphraseLine(status) {
  const { key } = status
  if (!key.createdAt) return { key: 'backup.passphraseNone', at: null }
  if (key.checkedAt === null) return { key: 'backup.passphraseUnconfirmed', at: null }
  return { key: 'backup.passphraseOk', at: key.checkedAt }
}

/** @param {BackupStatus} status @returns {{ key: string, at: number | null }} */
export function backupSummary(status) {
  if (status.state === 'paused') return { key: 'protection.summary.paused', at: null }
  if (status.verdict === 'protected') return { key: 'protection.summary.backedUp', at: status.lastSuccessAt }
  if (status.verdictReason === 'not-set-up') return { key: 'protection.summary.notBackedUp', at: null }
  if (status.verdict === 'stopped') return { key: 'protection.summary.stopped', at: null }
  return { key: 'protection.summary.attention', at: null }
}
