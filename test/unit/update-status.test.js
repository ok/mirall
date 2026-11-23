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

const downloading = run([{ type: 'pass-start' }, { type: 'downloading' }])
const progress = (fraction, peers = 1) => ({ type: 'progress', fraction, peers })

test('a download reports whole percent, and nothing until it has been sized', (t) => {
  t.is(downloading.progress, null)
  t.is(run([progress(null)], downloading).progress, null)
  t.is(run([progress(0)], downloading).progress, 0, 'a sized download that has fetched nothing is at 0%')
  t.is(run([progress(0.429)], downloading).progress, 42)
})

test('a download never reads as complete before the update is staged', (t) => {
  t.is(run([progress(0.99)], downloading).progress, 99)
  t.is(run([progress(1)], downloading).progress, 99)
})

test('a download with no peer left is waiting and keeps its position', (t) => {
  const s = run([progress(0.5), progress(0.5, 0)], downloading)
  t.is(s.waitingForPeers, true)
  t.is(s.progress, 50)
  t.is(run([progress(0.5, 2)], s).waitingForPeers, false)
})

test('progress outside a download changes nothing', (t) => {
  t.is(reduceUpdateStatus(on, progress(0.5), NOW), on)
  const ready = run([{ type: 'ready', version: '1.13.0' }])
  t.is(reduceUpdateStatus(ready, progress(0.5), NOW), ready)
})

test('progress ends with the download', (t) => {
  const mid = run([progress(0.5, 0)], downloading)
  for (const end of [{ type: 'ready', version: '1.13.0' }, { type: 'pass-failed' }]) {
    const s = run([end], mid)
    t.is(s.progress, null, end.type)
    t.is(s.waitingForPeers, false, end.type)
  }
})

test('a newer download over a staged update starts its progress afresh', (t) => {
  const s = run([progress(0.5), { type: 'ready', version: '1.13.0' }, { type: 'downloading' }], downloading)
  t.is(s.state, 'downloading')
  t.is(s.progress, null)
  t.is(run([progress(0.1)], s).progress, 10)
})

test('the store notifies once per whole percent, not once per measurement', (t) => {
  const store = createUpdateStatus(downloading)
  const seen = []
  store.subscribe((s) => seen.push(s.progress))
  for (const fraction of [0.101, 0.104, 0.109, 0.11, 0.119]) store.dispatch(progress(fraction))
  t.alike(seen, [10, 11])
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

const policy = (mode, held) => ({ type: 'policy', mode, held })

test('the status starts in automatic mode with nothing held', (t) => {
  t.is(on.mode, 'automatic')
  t.is(on.held, false)
})

test('a newer version that waits for the user is available, and a later check keeps it', (t) => {
  const s = run([{ type: 'pass-start' }, { type: 'available', version: '2.0.0' }, { type: 'pass-end', reached: true, manual: false }])
  t.is(s.state, 'available')
  t.is(s.nextVersion, '2.0.0')
  t.is(s.lastCheckedAt, NOW)
  t.is(reduceUpdateStatus(s, { type: 'pass-start' }, NOW), s, 'a pass does not hide it behind "checking"')
  t.is(reduceUpdateStatus(s, { type: 'available', version: '2.0.0' }, NOW), s, 'the same version again changes nothing')
  t.is(run([{ type: 'pass-failed' }], s).state, 'available')
})

test('a waiting version that is gone again leaves the build current', (t) => {
  const s = run([{ type: 'available', version: '2.0.0' }, { type: 'available', version: null }])
  t.is(s.state, 'idle')
  t.is(s.nextVersion, null)
  t.is(reduceUpdateStatus(on, { type: 'available', version: null }, NOW), on, 'nothing waited, nothing changes')
})

test('an approved version downloads and stages as ready', (t) => {
  const s = run([{ type: 'available', version: '2.0.0' }, policy('notify', false), { type: 'downloading' }, { type: 'ready', version: '2.0.0' }])
  t.is(s.state, 'ready')
})

test('an update staged while it is held waits for the user instead of reading as ready', (t) => {
  const s = run([policy('notify', true), { type: 'downloading' }, { type: 'ready', version: '2.0.0' }])
  t.is(s.state, 'available')
  t.is(s.nextVersion, '2.0.0')
})

test('switching from automatic to notify sends a staged update back to waiting', (t) => {
  const ready = run([{ type: 'ready', version: '2.0.0' }])
  const s = run([policy('notify', true)], ready)
  t.is(s.state, 'available')
  t.is(s.mode, 'notify')
  t.is(run([policy('notify', false)], ready).state, 'ready', 'one that may still install stays ready')
})

test('the mode reaches the status even when nothing is in flight', (t) => {
  const s = run([policy('notify', false)])
  t.is(s.mode, 'notify')
  t.is(s.state, 'idle')
  t.is(run([policy('notify', false)], s), s, 'the same policy again changes nothing')
})

test('updates turned off ignore the mode', (t) => {
  const off = initialUpdateStatus({ offReason: 'flag', canRestart: false })
  t.is(run([policy('notify', true), { type: 'available', version: '2.0.0' }], off), off)
})
