// Notification preferences: the defaults and the coercion every stored copy passes through.
// Plain JS so it unit-tests in the Node runner without config-client.

/**
 * @typedef {{
 *   joinRequests: boolean,
 *   presence: boolean,
 *   newShares: boolean,
 *   fileReceived: boolean,
 *   transferComplete: boolean,
 *   transferError: boolean,
 *   transferPaused: boolean,
 * }} NotificationEventPrefs
 */
/** @typedef {{ enabled: boolean, sound: boolean, suppressWhenFocused: boolean, events: NotificationEventPrefs }} NotificationPrefs */

/** @type {NotificationPrefs} */
export const DEFAULT_PREFS = Object.freeze({
  enabled: true,
  sound: true,
  suppressWhenFocused: true,
  events: Object.freeze({
    joinRequests: true,
    presence: false,
    newShares: true,
    fileReceived: true,
    transferComplete: true,
    transferError: true,
    transferPaused: false,
  }),
})

/** @param {string | number | boolean | object | null | undefined} v @returns {v is Record<string, string | number | boolean | object | null>} */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** @param {string | number | boolean | object | null | undefined} v @param {boolean} fallback */
function coerceBool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback
}

// A stored copy without `presence` predates it. Every save wrote the whole set, so a came-online
// switch that is on is only the old default; the went-offline switch, off by default, is on only
// when someone turned it on, and that alone carries presence alerts over.
/** @param {Record<string, string | number | boolean | object | null>} events */
function storedPresence(events) {
  if (typeof events.presence === 'boolean') return events.presence
  return events.memberLeft === true || DEFAULT_PREFS.events.presence
}

/** @param {object | null | undefined} raw @returns {NotificationPrefs} */
export function coercePrefs(raw) {
  if (!raw || !isObject(raw)) return DEFAULT_PREFS
  const stored = isObject(raw.events) ? raw.events : {}
  const d = DEFAULT_PREFS.events
  return {
    enabled: coerceBool(raw.enabled, DEFAULT_PREFS.enabled),
    sound: coerceBool(raw.sound, DEFAULT_PREFS.sound),
    suppressWhenFocused: coerceBool(raw.suppressWhenFocused, DEFAULT_PREFS.suppressWhenFocused),
    events: {
      joinRequests: coerceBool(stored.joinRequests, d.joinRequests),
      presence: storedPresence(stored),
      newShares: coerceBool(stored.newShares, d.newShares),
      fileReceived: coerceBool(stored.fileReceived, d.fileReceived),
      transferComplete: coerceBool(stored.transferComplete, d.transferComplete),
      transferError: coerceBool(stored.transferError, d.transferError),
      transferPaused: coerceBool(stored.transferPaused, d.transferPaused),
    },
  }
}
