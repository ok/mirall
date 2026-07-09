import { useRef, useCallback } from 'react'

// begin() opens a new request generation; the returned isCurrent() says whether it is still
// the newest — the guard for async settles racing a later refresh.
export function useLatestWins() {
  const seqRef = useRef(0)
  return useCallback(() => {
    const seq = ++seqRef.current
    return () => seq === seqRef.current
  }, [])
}
