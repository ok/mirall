// The organization's backup folder on this device, resolved by the worker for this device's own
// platform, and whether a backup is required. Unmanaged: no folder, not required.
import { useId } from 'react'
import { useManaged } from './useManaged.js'
import { useManagedSetting } from './useManagedSetting.js'

export interface ManagedBackupFolder {
  folder: string | null
  org: string | null
  noteId: string
  required: boolean
}

export function useManagedBackupFolder(): ManagedBackupFolder {
  const managed = useManaged()
  const noteId = useId()
  const required = useManagedSetting('backup.required')
  return { folder: managed?.backupFolder ?? null, org: managed?.organization.name ?? null, noteId, required: required.locked }
}
