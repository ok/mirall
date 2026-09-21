import { useCallback, useEffect, useRef, useState } from 'react'
import { useRunAction } from './useRunAction.js'

const COPIED_MS = 2000

// "Copied" is reported only once the clipboard write has resolved; a rejected write — the window
// lost focus, the permission was refused — is reported instead. Only the latest copy's outcome is
// shown, and unmounting makes any write still in flight stale.
export function useClipboardCopy(): { copied: boolean; copy: (text: string) => void } {
  const runAction = useRunAction()
  const [copied, setCopied] = useState(false)
  const seqRef = useRef(0)
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reset = useCallback(() => {
    seqRef.current += 1
    if (resetRef.current !== null) clearTimeout(resetRef.current)
    resetRef.current = null
    setCopied(false)
  }, [])

  useEffect(() => () => {
    seqRef.current += 1
    if (resetRef.current !== null) clearTimeout(resetRef.current)
  }, [])

  const copy = useCallback((text: string) => {
    reset()
    const seq = seqRef.current
    runAction(async () => {
      try {
        await navigator.clipboard.writeText(text)
      } catch (err) {
        if (seq === seqRef.current) throw err
        return
      }
      if (seq !== seqRef.current) return
      setCopied(true)
      resetRef.current = setTimeout(() => setCopied(false), COPIED_MS)
    }, 'copyFailed')
  }, [reset, runAction])

  return { copied, copy }
}
