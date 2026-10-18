import type { ReactNode } from 'react'
import { useManagedSetting } from '../../hooks/useManagedSetting.js'
import ManagedNote from './ManagedNote.js'
import type { ManagedSettingKey } from '../../../shared/contract/managed-settings.js'
import type { Lockable } from '../../types/ui.js'

interface ManagedFieldProps {
  settingKey: ManagedSettingKey
  children: (lock: Lockable) => ReactNode
  noteClassName?: string
}

// Wraps a control, or a group of controls showing one key, with the catalog key it shows. Without a
// license, or when the key is not locked, it renders the child untouched; otherwise the child gets
// the locked state and one note says why.
export default function ManagedField({ settingKey, children, noteClassName }: ManagedFieldProps) {
  const setting = useManagedSetting(settingKey)
  if (!setting.locked || !setting.org) return <>{children({})}</>
  return (
    <>
      {children({ locked: true, describedBy: setting.noteId })}
      <ManagedNote id={setting.noteId} org={setting.org} className={noteClassName} />
    </>
  )
}
