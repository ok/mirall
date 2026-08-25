// Renderless bridge turning connectivity transitions into toasts: sticky
// offline/connecting warnings and a brief back-online notice.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../toast/ToastProvider.js'
import { useConnectionStatus } from '../../hooks/useConnectionStatus.js'
import type { ConnectivityState, ReachabilityCause, ReachabilityVerdict } from '../../types.js'

const TOAST_ID = 'connectivity'

interface Props {
  onShowDetails: () => void
  onShowHelp: () => void
}

export default function ConnectivityToastBridge({ onShowDetails, onShowHelp }: Props) {
  const { state, reachability } = useConnectionStatus()
  const { t } = useTranslation()
  const toast = useToast()
  const previousStateRef = useRef<ConnectivityState | null>(null)
  const previousVerdictRef = useRef<ReachabilityVerdict | null>(null)
  const seenOnlineRef = useRef<boolean>(false)
  const onShowDetailsRef = useRef(onShowDetails)
  const onShowHelpRef = useRef(onShowHelp)

  useEffect(() => {
    onShowDetailsRef.current = onShowDetails
    onShowHelpRef.current = onShowHelp
  }, [onShowDetails, onShowHelp])

  const verdict = reachability?.verdict ?? null
  const cause: ReachabilityCause | null = reachability?.cause ?? null

  useEffect(() => {
    const previousVerdict = previousVerdictRef.current
    if (previousVerdict === verdict) return
    previousVerdictRef.current = verdict
    if (verdict !== 'blocked' && verdict !== 'at-risk') return

    if (cause === 'os-offline') {
      toast.error(t('connectivity.offlineToast'), {
        id: TOAST_ID,
        duration: 0,
        action: { label: t('connectivity.showDetails'), onClick: () => onShowDetailsRef.current() },
      })
      return
    }

    const key = cause ?? 'generic'
    const message = verdict === 'blocked'
      ? t(`connectivity.blockedToast.${key}`, { defaultValue: t('connectivity.blockedToast.generic') })
      : t(`connectivity.atRiskToast.${key}`, { defaultValue: t('connectivity.atRiskToast.generic') })
    const options = {
      id: TOAST_ID,
      duration: 0,
      action: { label: t('connectivity.whatCanIDo'), onClick: () => onShowHelpRef.current() },
    }
    if (verdict === 'blocked') toast.error(message, options)
    else toast.warning(message, options)
  }, [verdict, cause, t, toast])

  useEffect(() => {
    const previous = previousStateRef.current
    previousStateRef.current = state

    if (state === 'online') seenOnlineRef.current = true

    if (previous === state) return
    if (previous === null && state !== 'offline') return

    // The verdict effect above owns every degraded case, os-offline included; this one
    // keeps the boot and recovery transitions it does not cover.
    if (verdict === 'blocked' || verdict === 'at-risk') return

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
  }, [state, verdict, t, toast])

  return null
}
