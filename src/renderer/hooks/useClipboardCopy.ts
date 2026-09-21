import { useCallback, useEffect, useRef, useState } from 'react'
import { useRunAction } from './useRunAction.js'

const COPIED_MS = 2000

// "Copied" is reported only once the clipboard write has resolved; a rejected write — the window
// lost focus, the permission was refused — is reported instead.
export function useClipboardCopy(): { copied: boolean; copy: (text: string) => void } {
  const runAction = useRunAction()
  const [copied, setCopied] = useState(false)
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (resetRef.current !== null) clearTimeout(resetRef.current)
  }, [])

  const copy = useCallback((text: string) => {
    if (resetRef.current !== null) clearTimeout(resetRef.current)
    setCopied(false)
    runAction(async () => {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      resetRef.current = setTimeout(() => setCopied(false), COPIED_MS)
    }, 'copyFailed')
  }, [runAction])

  return { copied, copy }
}
