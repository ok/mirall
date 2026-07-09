import { useEffect, useRef } from 'react'
import i18n from '../i18n.js'
import { applyTheme, getStoredTheme } from '../theme.js'
import { restoreWindowBounds, trackWindowBounds } from '../window-bounds.js'
import { startNotifications } from '../notifications/dispatcher.js'
import type { Space } from '../types.js'

// Boot-time side effects that depend on nothing but `spaces`: theme + window bounds,
// stray file-drop swallowing, the first-hide tray notice, and member-name resolution
// for notifications.
export function useAppShellEffects(spaces: Space[]) {
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces

  useEffect(() => {
    applyTheme(getStoredTheme())
    restoreWindowBounds().then(() => trackWindowBounds())
  }, [])

  // A file dropped outside a registered drop target would otherwise make the
  // window navigate to it; swallow stray file drags app-wide while leaving other
  // native drops (e.g. dragging text into an input) untouched.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  useEffect(() => {
    return window.bridge.onFirstHideNotice((payload) => {
      const body = payload.platform === 'darwin'
        ? i18n.t('tray.firstHide.bodyMac')
        : i18n.t('tray.firstHide.bodyOther')
      window.bridge.notify({
        id: 'first-hide-notice',
        title: i18n.t('tray.firstHide.title'),
        body,
        silent: true,
      })
    })
  }, [])

  useEffect(() => {
    return startNotifications({
      getMemberName: (id, publicKey) => {
        const space = spacesRef.current.find((s) => s.spaceId === id)
        return space?.members.find((m) => m.publicKey === publicKey)?.displayName ?? null
      },
    })
  }, [])
}
