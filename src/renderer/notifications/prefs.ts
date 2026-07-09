// Notification preference store: defaults + shape coercion over config-client, change listeners, one-time localStorage migration.
import { getNotificationPrefs, setNotificationPrefs } from '../config-client.js'

export interface NotificationEventPrefs {
  memberJoined: boolean
  memberLeft: boolean
  transferComplete: boolean
  transferError: boolean
  transferPaused: boolean
}

export interface NotificationPrefs {
  enabled: boolean
  sound: boolean
  suppressWhenFocused: boolean
  events: NotificationEventPrefs
}

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  sound: true,
  suppressWhenFocused: true,
  events: {
    memberJoined: true,
    memberLeft: false,
    transferComplete: true,
    transferError: true,
    transferPaused: false,
  },
}

const LEGACY_STORAGE_KEY = 'mirall:notifications'

const PREFS_LISTENERS = new Set<(prefs: NotificationPrefs) => void>()

function migrateLegacy(): void {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (raw === null) return
    setNotificationPrefs(coercePrefs(JSON.parse(raw)))
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {}
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function coercePrefs(raw: unknown): NotificationPrefs {
  if (!isObject(raw)) return DEFAULT_PREFS
  const eventsRaw = isObject(raw.events) ? raw.events : {}
  return {
    enabled: coerceBool(raw.enabled, DEFAULT_PREFS.enabled),
    sound: coerceBool(raw.sound, DEFAULT_PREFS.sound),
    suppressWhenFocused: coerceBool(raw.suppressWhenFocused, DEFAULT_PREFS.suppressWhenFocused),
    events: {
      memberJoined: coerceBool(eventsRaw.memberJoined, DEFAULT_PREFS.events.memberJoined),
      memberLeft: coerceBool(eventsRaw.memberLeft, DEFAULT_PREFS.events.memberLeft),
      transferComplete: coerceBool(eventsRaw.transferComplete, DEFAULT_PREFS.events.transferComplete),
      transferError: coerceBool(eventsRaw.transferError, DEFAULT_PREFS.events.transferError),
      transferPaused: coerceBool(eventsRaw.transferPaused, DEFAULT_PREFS.events.transferPaused),
    },
  }
}

export function getPrefs(): NotificationPrefs {
  return coercePrefs(getNotificationPrefs())
}

export function setPrefs(next: NotificationPrefs): void {
  setNotificationPrefs(next)
  PREFS_LISTENERS.forEach((cb) => cb(next))
}

export function onPrefsChange(cb: (prefs: NotificationPrefs) => void): () => void {
  PREFS_LISTENERS.add(cb)
  return () => { PREFS_LISTENERS.delete(cb) }
}

migrateLegacy()
