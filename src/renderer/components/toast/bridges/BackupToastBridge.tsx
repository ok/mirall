// Renderless bridge turning a stopped backup into one warning: when no backup has succeeded for ten
// days, with a way to the screen that fixes it. When the cause is a folder that is not connected, the
// toast says so, and says once when that folder is back; no other success is toasted. What to do on
// each change is backupToastDecision's.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../ToastProvider.js'
import { useBackupStatus } from '../../../hooks/useBackupStatus.js'
import { useManagedBackupFolder } from '../../../hooks/useManagedBackupFolder.js'
import { backupToastDecision, type BackupToastState } from '../../../model/backup-toast.js'
import { CODES } from '../../../../shared/contract/errors.js'

const TOAST_ID = 'backup-stale'

interface Props {
  onOpen: () => void
}

export default function BackupToastBridge({ onOpen }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const status = useBackupStatus()
  const locked = !!useManagedBackupFolder().folder
  const stale = status?.stale === true
  const offline = status?.lastError === CODES.BACKUP_TARGET_OFFLINE
  const folder = status?.folder ?? null
  const stateRef = useRef<BackupToastState | null>(null)
  const onOpenRef = useRef(onOpen)

  useEffect(() => {
    onOpenRef.current = onOpen
  }, [onOpen])

  useEffect(() => {
    const { state, action } = backupToastDecision({ previous: stateRef.current, stale, offline, folder })
    stateRef.current = state
    if (!action) return
    if (action.kind === 'dismiss') {
      toast.dismiss(TOAST_ID)
      return
    }
    if (action.kind === 'restored') {
      toast.success(t('backup.connectedAgainToast'), { id: TOAST_ID, duration: 4000 })
      return
    }
    // An organization's share cannot be swapped for another folder, so its toast only opens the screen.
    const choose = action.cause === 'offline' && !locked
    toast.warning(t(action.cause === 'offline' ? 'backup.offlineToast' : 'backup.staleToast'), {
      id: TOAST_ID,
      duration: 0,
      action: { label: t(choose ? 'backup.chooseAnotherFolder' : 'backup.open'), onClick: () => onOpenRef.current() },
    })
  }, [stale, offline, folder, locked, t, toast])

  return null
}
