import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../components/toast/ToastProvider.js'
import { setApplyArmed } from '../platform/relay-session.js'
import { useConnectionStatus } from './useConnectionStatus.js'

// The reconnect that applies a pending relay change, so only one that happened clears it. Inside
// its throttle window the worker answers with a refusal rather than a throw: the change stays
// pending and the refusal is reported. A rejection is the caller's to report. Resolves whether the
// reconnect happened.
export function useRelayReconnect(): () => Promise<boolean> {
  const { t } = useTranslation()
  const toast = useToast()
  const { reconnect } = useConnectionStatus()
  return useCallback(async () => {
    const res = await reconnect()
    if (!res.ok) {
      toast.error(t('networkStatus.reconnectThrottled'))
      return false
    }
    setApplyArmed(false)
    return true
  }, [reconnect, toast, t])
}
