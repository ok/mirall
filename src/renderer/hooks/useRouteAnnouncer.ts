import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { Screen } from '../shell/navigation.js'
import { SCREEN_TITLE_KEYS } from '../shell/screen-titles.js'

// On every navigation after the first paint: focus lands on the main landmark and the live region
// announces the new screen by name.
export function useRouteAnnouncer(screen: Screen): { mainRef: RefObject<HTMLElement | null>; announcement: string } {
  const { t } = useTranslation()
  const mainRef = useRef<HTMLElement>(null)
  const mountedRef = useRef(false)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    mainRef.current?.focus()
    setAnnouncement(t(SCREEN_TITLE_KEYS[screen]))
  }, [screen, t])

  return { mainRef, announcement }
}
