// What the Protection screen and the Profile row say about a backup status, as copy keys and the one
// action that helps. Pure, so every cause maps to the same words wherever it is shown. The worker
// decides the verdict and its reason (prompt-rules.js); this only names them.

/** @import { BackupStatus } from '../../shared/contract/responses.js' */
/** @import { IdentityProtection } from '../platform/global.js' */
/** @typedef {'protected' | 'at-risk' | 'stopped' | 'paused'} Lamp */
/** @typedef {'setup' | 'check' | 'new-key' | 'run' | null} Fix */
/** @typedef {'ok' | 'attention' | 'tip' | 'off'} Health */

/** @type {Record<IdentityProtection, { key: string, health: Health }>} */
export const IDENTITY_LINE = {
  protected: { key: 'settings.identityProtected', health: 'ok' },
  weak: { key: 'settings.identityWeak', health: 'attention' },
  disabled: { key: 'settings.identityDisabled', health: 'off' },
}

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

/** @param {BackupStatus} status @returns {{ lamp: Lamp, key: string, fix: Fix } | null} */
export function protectionBanner(status) {
  const lamp = protectionLamp(status)
  if (!lamp) return null
  if (lamp === 'paused') return { lamp, key: 'paused', fix: null }
  if (!status.verdictReason) return { lamp, key: 'protected', fix: null }
  return { lamp, ...BY_REASON[status.verdictReason] }
}

/** @param {BackupStatus} status @returns {{ health: Health, key: string, at: number | null, action: 'check' | 'new-key' | null }} */
export function recoveryKeyRow(status) {
  const { key, folder } = status
  if (!key.createdAt) {
    return folder
      ? { health: 'attention', key: 'backup.rowKeyMissing', at: null, action: 'new-key' }
      : { health: 'attention', key: 'protection.keyNotBackedUp', at: null, action: null }
  }
  if (!key.inFolder) return { health: 'attention', key: 'backup.rowKeyNotInFolder', at: null, action: 'check' }
  if (key.checkedAt === null) return { health: 'attention', key: 'backup.rowKeyUnconfirmed', at: null, action: 'check' }
  return { health: 'ok', key: 'backup.rowKeyOk', at: key.checkedAt, action: 'check' }
}

/** @param {BackupStatus} status @returns {{ health: Health, key: string, at: number | null, canSave: boolean }} */
export function keyCopyRow(status) {
  const { key, folder } = status
  if (!key.createdAt) return { health: 'off', key: folder ? 'protection.copyAfterKey' : 'protection.copyLater', at: null, canSave: false }
  if (key.secondCopyAt) return { health: 'ok', key: 'backup.rowCopyOk', at: key.secondCopyAt, canSave: true }
  return { health: 'tip', key: 'backup.rowCopyNone', at: null, canSave: true }
}

/** @param {BackupStatus} status @returns {{ data: string, at: number | null }} */
function dataPart(status) {
  if (status.state === 'paused') return { data: 'paused', at: null }
  if (status.verdict === 'protected') return { data: 'backedUp', at: status.lastSuccessAt }
  if (status.verdictReason === 'not-set-up') return { data: 'notBackedUp', at: null }
  if (status.verdict === 'stopped') return { data: 'stopped', at: null }
  return { data: 'attention', at: null }
}

// The identity key's phrase leads when known; alone, the data part is its own sentence.
/** @param {BackupStatus} status @param {IdentityProtection | null} identity @returns {{ lead: string | null, data: string, at: number | null }} */
export function protectionSummary(status, identity) {
  const { data, at } = dataPart(status)
  if (identity === null) return { lead: null, data: `protection.summary.${data}Alone`, at }
  return { lead: `protection.summary.key${identity[0].toUpperCase()}${identity.slice(1)}`, data: `protection.summary.${data}`, at }
}
