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

function paintTheme(mode: ThemeMode) {
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
  // Keeps the renderer's config cache in sync so the settings toggle re-reads the choice on remount.
  setThemePref(mode)
}

let confirmed: ThemeMode = getThemePref()
let themeSeq = 0

// Painted at once, then persisted through main's theme:set channel, which also matches the native
// window background to the rendered body so a fast OS resize shows no edge of the wrong color. A
// refusal paints back the last theme main accepted; only the latest choice owns that outcome.
export async function applyTheme(mode: ThemeMode): Promise<void> {
  const mine = ++themeSeq
  paintTheme(mode)
  try {
    await window.bridge?.setTheme?.(mode)
    if (mine === themeSeq) confirmed = mode
  } catch (err) {
    if (mine !== themeSeq) return
    paintTheme(confirmed)
    throw err
  }
}
