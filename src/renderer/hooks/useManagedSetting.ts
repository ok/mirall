// Whether one catalog key is set by the organization. Unlicensed: never locked, no organization.
import { useId } from 'react'
import { useManaged } from './useManaged.js'
import type { ManagedSettingKey } from '../../shared/contract/managed-settings.js'

export interface ManagedSetting {
  locked: boolean
  org: string | null
  noteId: string
}

export function useManagedSetting(key: ManagedSettingKey): ManagedSetting {
  const managed = useManaged()
  const noteId = useId()
  const locked = managed?.locked.includes(key) ?? false
  return { locked, org: locked && managed ? managed.organization.name : null, noteId }
}
