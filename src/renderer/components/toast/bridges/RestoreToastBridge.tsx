// Renderless bridge saying, once, that a restored profile was confirmed and can be changed again.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../ToastProvider.js'

interface RestoreToastBridgeProps {
  active: boolean
}

export default function RestoreToastBridge({ active }: RestoreToastBridgeProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const wasActive = useRef(active)

  useEffect(() => {
    if (wasActive.current && !active) toast.success(t('restore.released'))
    wasActive.current = active
  }, [active, t, toast])

  return null
}
