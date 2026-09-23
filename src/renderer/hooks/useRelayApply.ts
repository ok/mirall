// The relay change that has not reached the live connections: whether to say so, and the act that
// applies it. The worker applies a change itself whenever nothing is moving, so this is armed from
// its reply rather than from the change — and gated on live status, so it clears when the peers
// cycle by themselves.
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { RelayApplyResult as WorkerRelayApplyResult } from '../../shared/contract/responses.js'
import { restartWorker } from '../ipc/ipc.js'
import { relayApplyNotice, type RelayApplyNotice } from '../model/relay-apply.js'
import type { RelayMode } from '../platform/config-client.js'
import { isApplyArmed, setApplyArmed, subscribeRelaySession } from '../platform/relay-session.js'
import { useConnectionStatus } from './useConnectionStatus.js'
import { useRelayReconnect } from './useRelayReconnect.js'
import { useRunAction } from './useRunAction.js'

export type RelayApplyResult = Pick<WorkerRelayApplyResult, 'mismatch' | 'reconnected'>

interface UseRelayApply {
  notice: RelayApplyNotice | null
  busy: boolean
  arm: (applied: RelayApplyResult | null) => void
  act: () => void
}

export function useRelayApply(mode: RelayMode, pendingIdentity: boolean): UseRelayApply {
  const { status } = useConnectionStatus()
  const run = useRunAction()
  const relayReconnect = useRelayReconnect()
  const armed = useSyncExternalStore(subscribeRelaySession, isApplyArmed, isApplyArmed)
  const [busy, setBusy] = useState(false)

  const arm = useCallback((applied: RelayApplyResult | null) => {
    setApplyArmed(!!applied?.mismatch && applied.reconnected !== true)
  }, [])

  // One act for one notice: a pinned identity is fixed when the DHT node is built, so it takes a new
  // process, and everything else takes a reconnect. Neither disarms anything on the way out — the
  // reconnect clears the flag only when it happened, and the restart clears it through the new
  // worker's greeting — so an act that resolves without doing anything leaves the notice up.
  const act = useCallback(() => {
    setBusy(true)
    run(async () => {
      try {
        if (pendingIdentity) await restartWorker()
        else await relayReconnect()
      } finally {
        setBusy(false)
      }
    })
  }, [run, relayReconnect, pendingIdentity])

  return {
    notice: relayApplyNotice({ mode, relay: status?.relay ?? null, armed, pendingIdentity }),
    busy,
    arm,
    act,
  }
}
