// Renderless bridge turning a stopped backup into one warning: when no backup has succeeded for ten
// days, once per transition, with a way to the screen that fixes it. Never a toast for a success.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../ToastProvider.js'
import { useBackupStatus } from '../../../hooks/useBackupStatus.js'

const TOAST_ID = 'backup-stale'

interface Props {
  onOpen: () => void
}

export default function BackupToastBridge({ onOpen }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const status = useBackupStatus()
  const stale = status?.stale === true
  const wasStale = useRef(false)
  const onOpenRef = useRef(onOpen)

  useEffect(() => {
    onOpenRef.current = onOpen
  }, [onOpen])

  useEffect(() => {
    const before = wasStale.current
    wasStale.current = stale
    if (stale && !before) {
      toast.warning(t('backup.staleToast'), { id: TOAST_ID, duration: 0, action: { label: t('backup.open'), onClick: () => onOpenRef.current() } })
    } else if (!stale && before) {
      toast.dismiss(TOAST_ID)
    }
  }, [stale, t, toast])

  return null
}
