// Applies the light/dark/system theme: dark class + CSS color-scheme, mirrored to main for the native window background.
import { getThemePref, setThemePref } from './config-client.js'

export type ThemeMode = 'light' | 'dark' | 'system'

const mql = window.matchMedia('(prefers-color-scheme: dark)')
let systemListener: ((e: MediaQueryListEvent) => void) | null = null

function setDarkClass(enabled: boolean) {
  document.documentElement.classList.toggle('dark', enabled)
  // Tell Chromium which scheme we're in so native UI (scrollbars, form
  // controls) renders dark instead of the light default bleeding through.
  // Without this the OS overlay scrollbar shows as a light pill on the
  // dark UI; it also lets the standard scrollbar-color styling resolve.
  document.documentElement.style.colorScheme = enabled ? 'dark' : 'light'
}

export function getStoredTheme(): ThemeMode {
  return getThemePref()
}

export function applyTheme(mode: ThemeMode) {
  if (systemListener) {
    mql.removeEventListener('change', systemListener)
    systemListener = null
  }

  if (mode === 'system') {
    setDarkClass(mql.matches)
    systemListener = (e) => setDarkClass(e.matches)
    mql.addEventListener('change', systemListener)
  } else {
    setDarkClass(mode === 'dark')
  }

  // Keep the renderer's config cache in sync with the choice so the settings
  // toggle re-reads the correct value on remount (persistence itself is done
  // by the setTheme mirror below, via the main-process theme:set channel).
  setThemePref(mode)

  // Mirror to main so the BrowserWindow's native background color matches
  // the rendered body — prevents a flash of the wrong color along the
  // resize edges when the OS resizes the window faster than Chromium can
  // repaint.
  window.bridge?.setTheme?.(mode)
}
