import { useEffect } from 'react'
import type { FocusEvent } from 'react'
import { makeTabIntentTracker } from '../tabIntent.js'

const tabIntent = makeTabIntentTracker()

export function useSkipLinkFocusGuard(): (e: FocusEvent<HTMLAnchorElement>) => void {
  useEffect(() => {
    const noteKey = (e: KeyboardEvent) => tabIntent.noteKeyDown(e.key, performance.now())
    document.addEventListener('keydown', noteKey, true)
    return () => document.removeEventListener('keydown', noteKey, true)
  }, [])
  return (e) => {
    if (!tabIntent.isTabIntent(performance.now())) e.currentTarget.blur()
  }
}
