import test from 'brittle'
import { connectionDesc, activityDesc } from '../../src/renderer/profileRows.js'

// Echoes the key plus its interpolations, so composition is observable without i18next. Rendered
// as key[a=1,b=2] rather than JSON so a nested call stays readable instead of being escaped.
const t = (key, vars) => (
  vars ? `${key}[${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}]` : key
)

const config = (enabled) => ({ enabled, retentionDays: 30, maxEntries: 10000 })

test('connectionDesc composes the shipped state and peer strings', (t_) => {
  const out = connectionDesc(t, 'online', 3)
  t_.ok(out.includes('connectivity.online'), 'uses the shipped connectivity string')
  t_.ok(out.includes('count=3'), 'passes the peer count through the shipped plural')
  t_.ok(out.startsWith('account.connectionDesc'), 'joined by the composition key')
})

test('connectionDesc treats a missing peer count as zero', (t_) => {
  t_.ok(connectionDesc(t, 'offline', undefined).includes('count=0'), 'undefined')
  t_.ok(connectionDesc(t, 'offline', null).includes('count=0'), 'null')
})

test('connectionDesc carries each connectivity state', (t_) => {
  for (const state of ['online', 'connecting', 'offline']) {
    t_.ok(connectionDesc(t, state, 1).includes(`connectivity.${state}`), state)
  }
})

test('activityDesc falls back to the blurb before the stats land', (t_) => {
  t_.is(activityDesc(t, null, null), 'account.activityDesc', 'nothing loaded')
  t_.is(activityDesc(t, config(true), null), 'account.activityDesc', 'config only')
  t_.is(activityDesc(t, null, { count: 12 }), 'account.activityDesc', 'stats only')
})

test('activityDesc reports the count while recording is on', (t_) => {
  const out = activityDesc(t, config(true), { count: 1284 })
  t_.ok(out.startsWith('activityLogSettings.openLogSummary'), 'no recording-off wrapper')
  t_.ok(out.includes('count=1284'), 'carries the count')
})

test('activityDesc says recording is off and still reports what is kept', (t_) => {
  const out = activityDesc(t, config(false), { count: 1284 })
  t_.ok(out.startsWith('account.recordingOff'), 'wrapped in the off-state key')
  t_.ok(out.includes('count=1284'), 'still carries the kept count')
})

test('activityDesc reports an empty log as zero, not as the blurb', (t_) => {
  const out = activityDesc(t, config(true), { count: 0 })
  t_.ok(out.includes('count=0'))
  t_.absent(out.includes('account.activityDesc'))
})
