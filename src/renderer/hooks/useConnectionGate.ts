import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnectionStatus } from './useConnectionStatus.js'
import { useSpaces } from './useSpaces.js'

interface ConnectionGate {
  showConnectionProblem: boolean
  dismiss: () => void
}

// Substituting the whole spaces screen is only right when there is nothing to substitute
// for. With spaces present the toast carries the signal instead.
export function useConnectionGate(): ConnectionGate {
  const { reachability } = useConnectionStatus()
  const { spaces, loading } = useSpaces()
  const [dismissed, setDismissed] = useState(false)
  const sinceRef = useRef<number | null>(null)

  const since = reachability?.since ?? null

  useEffect(() => {
    if (sinceRef.current === since) return
    sinceRef.current = since
    // A new episode re-asserts itself rather than staying silently dismissed.
    setDismissed(false)
  }, [since])

  const dismiss = useCallback(() => setDismissed(true), [])

  const verdict = reachability?.verdict
  const degraded = verdict === 'blocked' || verdict === 'at-risk'

  return {
    showConnectionProblem: degraded && !loading && spaces.length === 0 && !dismissed,
    dismiss,
  }
}
