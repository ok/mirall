import test from 'brittle'
import { coercePrefs, DEFAULT_PREFS } from '../../src/renderer/notifications/prefs-shape.js'

test('nothing stored reads as the defaults: membership and shares on, presence off', (t) => {
  for (const raw of [null, undefined, 'x', [], {}]) t.alike(coercePrefs(raw), DEFAULT_PREFS)
  const { events } = DEFAULT_PREFS
  t.ok(events.joinRequests && events.newShares && events.fileReceived)
  t.absent(events.presence, 'presence is opt-in')
})

// REGRESSION (NOTIFY-3: every save stored the old came-online default, so it read as an opt-in and
// switched presence alerts on for anyone who had changed any notification setting.)
test('REGRESSION (NOTIFY-3): a stored copy without presence carries over only a deliberate went-offline choice', (t) => {
  t.is(coercePrefs({ sound: false, events: { memberJoined: true, memberLeft: false } }).events.presence, false, 'the old defaults stay off')
  t.is(coercePrefs({ events: { memberJoined: false, memberLeft: true } }).events.presence, true)
  t.is(coercePrefs({ events: { memberJoined: true, memberLeft: true } }).events.presence, true)
  t.is(coercePrefs({ events: { memberJoined: false, memberLeft: false } }).events.presence, false)
  t.is(coercePrefs({ events: { presence: false, memberJoined: true } }).events.presence, false, 'an explicit presence wins')
})

test('each field falls back on its own when its stored value is not a boolean', (t) => {
  const prefs = coercePrefs({ enabled: false, sound: 'loud', events: { newShares: false, transferPaused: 1 } })
  t.is(prefs.enabled, false)
  t.is(prefs.sound, DEFAULT_PREFS.sound)
  t.is(prefs.events.newShares, false)
  t.is(prefs.events.transferPaused, DEFAULT_PREFS.events.transferPaused)
  t.is(prefs.events.fileReceived, DEFAULT_PREFS.events.fileReceived)
})
