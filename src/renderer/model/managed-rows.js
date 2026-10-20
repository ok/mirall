// The Organization page's list of what the organization manages: one row per settings page it
// locks, and one line per locked value in the words of the control it locks. Pure.

/**
 * @import { ManagedView } from '../../shared/contract/responses.js'
 * @typedef {'network-settings' | 'activity-log-settings' | 'backup-settings'} ManagedPage
 * @typedef {{ key: string, count?: number } | { text: string }} ManagedValue
 * @typedef {{ label: string, value: ManagedValue | null, join: ': ' | ' ' }} ManagedLine
 * @typedef {{ page: ManagedPage, lines: ManagedLine[] }} ManagedRow
 */

/** @param {string} label @param {ManagedValue | null} [value] @param {': ' | ' '} [join] @returns {ManagedLine} */
const line = (label, value = null, join = ': ') => ({ label, value, join })

/** @param {ManagedView} view @returns {ManagedLine[]} */
function networkLines(view) {
  const mode = view.values.relayMode
  const keyLocked = view.locked.includes('network.relayKey')
  if (mode === 'off') return [line('networkSettings.relays.useRelay', { key: 'networkStatus.summary.relayValue.off' })]
  const lines = []
  if (mode !== null || keyLocked) lines.push(line('networkSettings.relays.useRelay', keyLocked ? { text: view.organization.name } : null))
  if (mode === 'always') lines.push(line('networkSettings.relays.alwaysLabel'))
  return lines
}

/** @param {ManagedView} view @returns {ManagedLine[]} */
function activityLogLines(view) {
  const lines = []
  if (view.locked.includes('audit.enabled')) lines.push(line('activityLogSettings.recordActivity'))
  const days = view.values.retentionDays
  if (days !== null) lines.push(line('activityLogSettings.retention', { key: 'activityLogSettings.retentionDays', count: days }, ' '))
  return lines
}

/** @param {ManagedView} view @returns {ManagedLine[]} */
function backupLines(view) {
  const lines = []
  if (view.locked.includes('backup.required')) lines.push(line('backup.autoLabel'))
  if (view.backupFolder) lines.push(line('backup.folderTitle', { text: view.backupFolder }))
  return lines
}

/** @param {ManagedView} view @returns {ManagedRow[]} */
export function managedRows(view) {
  /** @type {ManagedRow[]} */
  const rows = [
    { page: 'network-settings', lines: networkLines(view) },
    { page: 'activity-log-settings', lines: activityLogLines(view) },
    { page: 'backup-settings', lines: backupLines(view) },
  ]
  return rows.filter((row) => row.lines.length > 0)
}
