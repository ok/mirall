import test from 'brittle'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { initialUpdateStatus, reduceUpdateStatus, createUpdateStatus } = require('../../src/main/update-status.js')

const NOW = 1_700_000_000_000
const on = initialUpdateStatus({ offReason: null, canRestart: true })
const run = (events, from = on) => events.reduce((s, e) => reduceUpdateStatus(s, e, NOW), from)

test('updates turned off stay off whatever the updater does', (t) => {
  const off = initialUpdateStatus({ offReason: 'deb-install', canRestart: false })
  t.is(off.state, 'off')
  t.is(off.offReason, 'deb-install')
  t.is(run([{ type: 'pass-start' }, { type: 'ready', version: '2.0.0' }], off), off)
})

test('a pass that reached a peer and found nothing newer is a confirmed check', (t) => {
  const s = run([{ type: 'pass-start' }, { type: 'pass-end', reached: true, manual: false }])
  t.is(s.state, 'idle')
  t.is(s.lastCheckedAt, NOW)
})

test('a background pass with no peers proves nothing and leaves no trace', (t) => {
  const s = run([{ type: 'pass-start' }, { type: 'pass-end', reached: false, manual: false }])
  t.is(s.state, 'idle')
  t.is(s.lastCheckedAt, null)
})

test('a check the user asked for says when it could not reach the network', (t) => {
  const s = run([{ type: 'pass-start' }, { type: 'pass-end', reached: false, manual: true }])
  t.is(s.state, 'error')
  t.is(s.lastCheckedAt, null)
})

test('a failed pass is an error', (t) => {
  t.is(run([{ type: 'pass-start' }, { type: 'pass-failed' }]).state, 'error')
})

test('a download walks checking → downloading → ready and records the version', (t) => {
  const s = run([{ type: 'pass-start' }, { type: 'downloading' }, { type: 'ready', version: '1.13.0' }, { type: 'pass-end', reached: true, manual: false }])
  t.is(s.state, 'ready')
  t.is(s.nextVersion, '1.13.0')
  t.is(s.lastCheckedAt, NOW)
})

test('a staged update stays ready through later passes until a newer one downloads', (t) => {
  const ready = run([{ type: 'ready', version: '1.13.0' }])
  t.is(reduceUpdateStatus(ready, { type: 'pass-start' }, NOW), ready, 'a pass does not hide it behind "checking"')
  t.is(run([{ type: 'pass-failed' }], ready).state, 'ready', 'a failed pass does not either')
  t.is(run([{ type: 'downloading' }], ready).state, 'downloading')
})

test('the store notifies only on a change', (t) => {
  const store = createUpdateStatus(on)
  const seen = []
  const stop = store.subscribe((s) => seen.push(s.state))
  store.dispatch({ type: 'pass-start' })
  store.dispatch({ type: 'pass-start' })
  store.dispatch({ type: 'pass-end', reached: true, manual: false })
  stop()
  store.dispatch({ type: 'pass-start' })
  t.alike(seen, ['checking', 'idle'])
  t.is(store.get().state, 'checking')
})
