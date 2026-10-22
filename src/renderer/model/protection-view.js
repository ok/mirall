// What the Backup screen and the Profile row say about a backup status, as copy keys and the one
// action that helps. Pure, so every cause maps to the same words wherever it is shown. The worker
// decides the verdict and its reason (prompt-rules.js); this only names them.

/** @import { BackupStatus } from '../../shared/contract/responses.js' */
/** @typedef {'protected' | 'at-risk' | 'stopped' | 'paused'} Lamp */
/** @typedef {'setup' | 'check' | 'new-key' | 'run' | null} Fix */

/** @type {Record<Exclude<NonNullable<BackupStatus['verdictReason']>, 'offline'>, { key: string, fix: Fix }>} */
const BY_REASON = {
  'not-set-up': { key: 'notSetUp', fix: 'setup' },
  'required-not-set-up': { key: 'requiredNotSetUp', fix: 'setup' },
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

// A protected backup still offers Back up now: the banner is where the screen's one action lives. A
// folder that is not connected is named for what can fix it: an organization's share cannot be swapped
// for another folder, and a folder gone long enough to stop the backup says how long, too.
/** @param {BackupStatus} status @param {{ locked?: boolean }} [opts] @returns {{ lamp: Lamp, key: string, fix: Fix } | null} */
export function protectionBanner(status, { locked = false } = {}) {
  const lamp = protectionLamp(status)
  if (!lamp) return null
  if (lamp === 'paused') return { lamp, key: 'paused', fix: null }
  if (!status.verdictReason) return { lamp, key: 'protected', fix: 'run' }
  if (status.verdictReason === 'offline') return { lamp, key: `offline${locked ? 'Share' : ''}${lamp === 'stopped' ? 'Stale' : ''}`, fix: 'run' }
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
  if (status.verdictReason === 'not-set-up' || status.verdictReason === 'required-not-set-up') return { key: 'protection.summary.notBackedUp', at: null }
  if (status.verdict === 'stopped') return { key: 'protection.summary.stopped', at: null }
  return { key: 'protection.summary.attention', at: null }
}
