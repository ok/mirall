// The relay change that has not reached the live connections: whether to say so, and the act that
// applies it. The worker applies a change itself whenever nothing is moving, so this is armed from
// its reply rather than from the change — and gated on live status, so it clears when the peers
// cycle by themselves.
import { useCallback, useState } from 'react'
import type { RelayApplyResult as WorkerRelayApplyResult } from '../../shared/contract/responses.js'
import { relayApplyNotice, type RelayApplyNotice } from '../model/relay-apply.js'
import type { RelayMode } from '../platform/config-client.js'
import { isApplyArmed, setApplyArmed } from '../platform/relay-session.js'
import { useConnectionStatus } from './useConnectionStatus.js'
import { useRelayReconnect } from './useRelayReconnect.js'
import { useRunAction } from './useRunAction.js'

export type RelayApplyResult = Pick<WorkerRelayApplyResult, 'mismatch' | 'reconnected'>

interface UseRelayApply {
  notice: RelayApplyNotice | null
  reconnecting: boolean
  arm: (applied: RelayApplyResult | null) => void
  apply: () => void
}

export function useRelayApply(mode: RelayMode, pendingIdentity: boolean): UseRelayApply {
  const { status } = useConnectionStatus()
  const run = useRunAction()
  const relayReconnect = useRelayReconnect()
  const [armed, setArmed] = useState(isApplyArmed)
  const [reconnecting, setReconnecting] = useState(false)

  const arm = useCallback((applied: RelayApplyResult | null) => {
    const next = !!applied?.mismatch && applied.reconnected !== true
    setApplyArmed(next)
    setArmed(next)
  }, [])

  // Disarmed on the way out rather than on the way back: the notice is gated on live status too, so
  // a mismatch that genuinely survives the reconnect re-renders on the next frame.
  const apply = useCallback(() => {
    setReconnecting(true)
    run(async () => {
      try {
        if (await relayReconnect()) setArmed(false)
      } finally {
        setReconnecting(false)
      }
    })
  }, [run, relayReconnect])

  return {
    notice: relayApplyNotice({ mode, relay: status?.relay ?? null, armed, pendingIdentity }),
    reconnecting,
    arm,
    apply,
  }
}
