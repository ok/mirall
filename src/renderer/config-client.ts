// Synchronous facade over main's config.json (window.bridge get/setConfig): cached reads, patch writes, one-time localStorage migration.
import type { ThemeMode } from './theme.js'
import type { NotificationPrefs } from './notifications/prefs.js'

export type RelayMode = 'off' | 'auto' | 'always'

export interface RelayTestVerdict {
  at: number
  ok: boolean
}

export interface RelayEntry {
  id: string
  label: string
  publicKey: string
  enabled: boolean
  lastTest: RelayTestVerdict | null
}

export interface RendererConfig {
  appearance: { theme: ThemeMode; locale: string | null }
  notifications: NotificationPrefs | null
  ui: { lastSeenVersion: string | null; feedbackEmail: string }
  // Bandwidth caps share this group; main owns them via its own setBandwidth path,
  // so they are readable here but never written through setConfig.
  network: { downloadKBps: number; uploadKBps: number; relayMode: RelayMode; relays: RelayEntry[] }
  // Read-only: main populates it from feature-flags.json and setRenderer has no
  // counterpart, so the renderer can observe a flag but never write one.
  features: { relay: boolean }
}

export interface RendererConfigPatch {
  appearance?: { theme?: ThemeMode; locale?: string }
  notifications?: NotificationPrefs
  ui?: { lastSeenVersion?: string; feedbackEmail?: string }
  network?: { relayMode?: RelayMode; relays?: RelayEntry[] }
}

const FALLBACK: RendererConfig = {
  appearance: { theme: 'system', locale: null },
  notifications: null,
  ui: { lastSeenVersion: null, feedbackEmail: '' },
  network: { downloadKBps: 0, uploadKBps: 0, relayMode: 'off', relays: [] },
  features: { relay: false },
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

async function persistAndAdopt(patch: RendererConfigPatch): Promise<RendererConfig> {
  const stored = await window.bridge?.setConfig?.(patch)
  return stored ?? cache
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

// Flags reach the renderer through the boot snapshot (sendSync), so a gated section
// resolves on first paint rather than mounting absent and popping in.
export function isRelayFeatureEnabled(): boolean {
  return cache.features.relay === true
}

export function getRelayMode(): RelayMode {
  return cache.network.relayMode
}

export function getRelays(): RelayEntry[] {
  return cache.network.relays
}

// One round trip for both fields, and the cache adopts what main actually stored —
// main drops duplicates, caps the list and truncates labels, so the optimistic array
// can differ from the persisted one.
export async function persistRelayConfig(mode: RelayMode, relays: RelayEntry[]): Promise<RelayEntry[]> {
  cache.network.relayMode = mode
  cache.network.relays = relays
  const stored = await persistAndAdopt({ network: { relayMode: mode, relays } })
  cache.network.relayMode = stored.network.relayMode
  cache.network.relays = stored.network.relays
  return stored.network.relays
}
