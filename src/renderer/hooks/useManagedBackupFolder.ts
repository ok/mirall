// The organization's backup folder on this device, resolved by the worker, and whether a backup is
// required. Unmanaged: no folder, not required.
import { useManaged } from './useManaged.js'
import { useManagedSetting } from './useManagedSetting.js'
import { backupFolderKey, type BackupPlatform } from '../../shared/contract/managed-settings.js'

function devicePlatform(): BackupPlatform {
  const os = typeof window.bridge === 'undefined' ? 'other' : window.bridge.getPlatform()
  return os === 'darwin' ? 'macos' : os === 'win32' ? 'windows' : 'linux'
}

export interface ManagedBackupFolder {
  folder: string | null
  org: string | null
  noteId: string
  required: boolean
}

export function useManagedBackupFolder(): ManagedBackupFolder {
  const managed = useManaged()
  const folderLock = useManagedSetting(backupFolderKey(devicePlatform()))
  const required = useManagedSetting('backup.required')
  const folder = folderLock.locked ? managed?.backupFolder ?? null : null
  return { folder, org: managed?.organization.name ?? null, noteId: folderLock.noteId, required: required.locked }
}
