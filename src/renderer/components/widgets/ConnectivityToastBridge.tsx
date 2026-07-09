// Renderless bridge turning connectivity transitions into toasts: sticky
// offline/connecting warnings and a brief back-online notice.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../toast/ToastProvider.js'
import { useConnectionStatus } from '../../hooks/useConnectionStatus.js'
import type { ConnectivityState } from '../../types.js'

const TOAST_ID = 'connectivity'

interface Props {
  onShowDetails: () => void
}

export default function ConnectivityToastBridge({ onShowDetails }: Props) {
  const { state } = useConnectionStatus()
  const { t } = useTranslation()
  const toast = useToast()
  const previousStateRef = useRef<ConnectivityState | null>(null)
  const seenOnlineRef = useRef<boolean>(false)
  const onShowDetailsRef = useRef(onShowDetails)

  useEffect(() => {
    onShowDetailsRef.current = onShowDetails
  }, [onShowDetails])

  useEffect(() => {
    const previous = previousStateRef.current
    previousStateRef.current = state

    if (state === 'online') seenOnlineRef.current = true

    if (previous === state) return
    if (previous === null && state !== 'offline') return

    if (state === 'offline') {
      toast.error(t('connectivity.offlineToast'), {
        id: TOAST_ID,
        duration: 0,
        action: {
          label: t('connectivity.showDetails'),
          onClick: () => onShowDetailsRef.current(),
        },
      })
      return
    }

    if (state === 'connecting') {
      if (!seenOnlineRef.current && previous === null) return
      toast.info(t('connectivity.connectingToast'), {
        id: TOAST_ID,
        duration: 0,
        action: {
          label: t('connectivity.showDetails'),
          onClick: () => onShowDetailsRef.current(),
        },
      })
      return
    }

    if (state === 'online' && previous !== null) {
      toast.success(t('connectivity.restoredToast'), {
        id: TOAST_ID,
        duration: 4000,
      })
    }
  }, [state, t, toast])

  return null
}
