// Synchronous facade over main's config.json (window.bridge get/setConfig): cached reads, patch writes, one-time localStorage migration.
import type { ThemeMode } from './theme.js'
import type { NotificationPrefs } from './notifications/prefs.js'

export interface RendererConfig {
  appearance: { theme: ThemeMode; locale: string | null }
  notifications: NotificationPrefs | null
  ui: { lastSeenVersion: string | null; feedbackEmail: string }
}

export interface RendererConfigPatch {
  appearance?: { theme?: ThemeMode; locale?: string }
  notifications?: NotificationPrefs
  ui?: { lastSeenVersion?: string; feedbackEmail?: string }
}

const FALLBACK: RendererConfig = {
  appearance: { theme: 'system', locale: null },
  notifications: null,
  ui: { lastSeenVersion: null, feedbackEmail: '' },
}

// INVARIANT — read this before adding a setting or "optimizing" a setter.
// `cache` is a one-time boot snapshot of main's config.json; it never re-reads
// mid-session. So the contract is: every value a component READS out of this
// cache must be WRITTEN through a setter here that mutates the cache first.
// Break it (write via a dedicated IPC channel that skips the cache, or drop the
// `cache.x = v` line from a setter) and the value looks correct until the
// control remounts, then silently reverts to the boot value. That was the theme
// bug: it persisted via the `theme:set` IPC but never touched the cache, so the
// settings toggle snapped back every visit — fixed by setThemePref() (see
// theme.ts). Every getXPref below has a matching cache-updating setXPref;
// keep it that way.
const cache: RendererConfig = window.bridge?.getConfig?.() ?? FALLBACK

function persist(patch: RendererConfigPatch): void {
  window.bridge?.setConfig?.(patch)
}

// One-time fold of the pre-unification localStorage keys into config.json, then
// clear them so subsequent boots read only from the unified store. Notification
// prefs migrate in notifications/prefs.ts (it owns their coercion).
function migrateLegacyLocalStorage(): void {
  try {
    const patch: RendererConfigPatch = {}
    const appearance: { theme?: ThemeMode; locale?: string } = {}
    const ui: { lastSeenVersion?: string; feedbackEmail?: string } = {}

    const theme = localStorage.getItem('mirall:theme')
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      appearance.theme = theme
      cache.appearance.theme = theme
    }
    const locale = localStorage.getItem('mirall.locale')
    if (locale) {
      appearance.locale = locale
      cache.appearance.locale = locale
    }
    const lastSeen = localStorage.getItem('mirall:lastSeenVersion')
    if (lastSeen) {
      ui.lastSeenVersion = lastSeen
      cache.ui.lastSeenVersion = lastSeen
    }
    const email = localStorage.getItem('mirall.feedback.email')
    if (email) {
      ui.feedbackEmail = email
      cache.ui.feedbackEmail = email
    }

    if (Object.keys(appearance).length > 0) patch.appearance = appearance
    if (Object.keys(ui).length > 0) patch.ui = ui
    if (patch.appearance || patch.ui) {
      persist(patch)
      localStorage.removeItem('mirall:theme')
      localStorage.removeItem('mirall.locale')
      localStorage.removeItem('mirall:lastSeenVersion')
      localStorage.removeItem('mirall.feedback.email')
      localStorage.removeItem('mirall:invite:format')
    }
  } catch {}
}

migrateLegacyLocalStorage()

export function getThemePref(): ThemeMode {
  return cache.appearance.theme
}

// Theme persistence is owned by the dedicated `theme:set` IPC channel (main
// writes appearance.theme to config.json and mirrors the native window
// background) — see applyTheme. This only keeps the renderer's read-cache in
// sync so the settings toggle reflects the current choice when it remounts
// mid-session, rather than snapping back to the boot-time value.
export function setThemePref(mode: ThemeMode): void {
  cache.appearance.theme = mode
}

export function getLocalePref(): string | null {
  return cache.appearance.locale
}

export function setLocalePref(code: string): void {
  cache.appearance.locale = code
  persist({ appearance: { locale: code } })
}

export function getNotificationPrefs(): NotificationPrefs | null {
  return cache.notifications
}

export function setNotificationPrefs(prefs: NotificationPrefs): void {
  cache.notifications = prefs
  persist({ notifications: prefs })
}

export function getLastSeenVersion(): string | null {
  return cache.ui.lastSeenVersion
}

export function setLastSeenVersion(version: string): void {
  cache.ui.lastSeenVersion = version
  persist({ ui: { lastSeenVersion: version } })
}

export function getFeedbackEmail(): string {
  return cache.ui.feedbackEmail
}

export function setFeedbackEmail(email: string): void {
  cache.ui.feedbackEmail = email
  persist({ ui: { feedbackEmail: email } })
}
