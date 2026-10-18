// The settings an organization can lock, by catalog key: the one list main, the worker, the renderer
// and the coverage tests read. The worker's catalog test holds it equal to catalog.v1.json's keys.
export const MANAGED_SETTING_KEYS = Object.freeze(/** @type {const} */ ([
  'network.relayMode',
  'network.relayKey',
  'audit.enabled',
  'audit.retentionDays',
  'audit.forwardingEnabled',
  'backup.folder.windows',
  'backup.folder.macos',
  'backup.folder.linux',
  'backup.required',
]))

/** @typedef {(typeof MANAGED_SETTING_KEYS)[number]} ManagedSettingKey */

export const BACKUP_PLATFORMS = Object.freeze(/** @type {const} */ (['windows', 'macos', 'linux']))

/** @typedef {(typeof BACKUP_PLATFORMS)[number]} BackupPlatform */

/**
 * @param {BackupPlatform} platform
 * @returns {ManagedSettingKey}
 */
export function backupFolderKey(platform) {
  return platform === 'windows' ? 'backup.folder.windows' : platform === 'macos' ? 'backup.folder.macos' : 'backup.folder.linux'
}
