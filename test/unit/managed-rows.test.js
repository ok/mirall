import test from 'brittle'
import { managedRows } from '../../src/renderer/model/managed-rows.js'

const ORG = { name: 'Acme Test GmbH', supportUrl: null, supportEmail: null }
const view = (patch) => ({
  organization: ORG,
  locked: [],
  updatedAt: 1,
  backupFolder: null,
  values: { relayMode: null, retentionDays: null },
  revoked: false,
  ...patch,
})

test('nothing locked lists nothing', (t) => {
  t.alike(managedRows(view({})), [])
})

test('every page the organization locks gets one row, in the order of the page', (t) => {
  const rows = managedRows(view({
    locked: ['network.relayMode', 'network.relayKey', 'audit.enabled', 'audit.retentionDays', 'backup.required', 'backup.folder.macos'],
    values: { relayMode: 'always', retentionDays: 90 },
    backupFolder: '/Volumes/backups/pat',
  }))
  t.alike(rows, [
    { page: 'network-settings', lines: [
      { label: 'networkSettings.relays.useRelay', value: { text: ORG.name }, join: ': ' },
      { label: 'networkSettings.relays.alwaysLabel', value: null, join: ': ' },
    ] },
    { page: 'activity-log-settings', lines: [
      { label: 'activityLogSettings.recordActivity', value: null, join: ': ' },
      { label: 'activityLogSettings.retention', value: { key: 'activityLogSettings.retentionDays', count: 90 }, join: ' ' },
    ] },
    { page: 'backup-settings', lines: [
      { label: 'backup.autoLabel', value: null, join: ': ' },
      { label: 'backup.folderTitle', value: { text: '/Volumes/backups/pat' }, join: ': ' },
    ] },
  ])
})

test('one locked key is one row with one line', (t) => {
  t.alike(managedRows(view({ locked: ['audit.enabled'] })), [
    { page: 'activity-log-settings', lines: [{ label: 'activityLogSettings.recordActivity', value: null, join: ': ' }] },
  ])
})

test('a relay the organization switches off says so, and an automatic one names no preference', (t) => {
  t.alike(managedRows(view({ locked: ['network.relayMode'], values: { relayMode: 'off', retentionDays: null } }))[0].lines, [
    { label: 'networkSettings.relays.useRelay', value: { key: 'networkStatus.summary.relayValue.off' }, join: ': ' },
  ])
  t.alike(managedRows(view({ locked: ['network.relayMode'], values: { relayMode: 'auto', retentionDays: null } }))[0].lines, [
    { label: 'networkSettings.relays.useRelay', value: null, join: ': ' },
  ])
})

test('a backup folder that does not resolve on this device is not listed', (t) => {
  t.alike(managedRows(view({ locked: ['backup.required'], backupFolder: null }))[0].lines, [
    { label: 'backup.autoLabel', value: null, join: ': ' },
  ])
})
