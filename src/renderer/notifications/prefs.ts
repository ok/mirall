// Notification preference store: reads and writes through config-client, coerced by prefs-shape.js, plus a one-time localStorage migration.
import { getNotificationPrefs, setNotificationPrefs } from '../platform/config-client.js'
import { coercePrefs, type NotificationPrefs } from './prefs-shape.js'

const LEGACY_STORAGE_KEY = 'mirall:notifications'

function migrateLegacy(): void {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (raw === null) return
    setNotificationPrefs(coercePrefs(JSON.parse(raw) as object | null)).then(
      () => localStorage.removeItem(LEGACY_STORAGE_KEY),
      (err) => console.error('notification prefs migration failed:', err),
    )
  } catch {}
}

export function getPrefs(): NotificationPrefs {
  return coercePrefs(getNotificationPrefs())
}

export function setPrefs(next: NotificationPrefs): Promise<void> {
  return setNotificationPrefs(next)
}

migrateLegacy()
