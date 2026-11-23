// The development stand-in for the updater, through the production mode control and status: what
// MIRALL_UPDATE_PREVIEW shows is what the same mode does with a real update drive.
import test from 'brittle'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPreviewUpdater } = require('../../src/main/update-preview.js')
const { createUpdateModeControl } = require('../../src/main/update-mode.js')
const { initialUpdateStatus, createUpdateStatus } = require('../../src/main/update-status.js')

function preview(mode) {
  const stored = { 'updates.mode': mode }
  const config = () => ({ get: (key) => stored[key], set: (key, value) => { stored[key] = value } })
  const status = createUpdateStatus(initialUpdateStatus({ offReason: null, canRestart: false }))
  let updater = null
  const control = createUpdateModeControl({
    running: '1.0.0', config, status, getUpdater: () => updater, prestages: false, runUserPass: (u) => u._debouncedUpdate(),
  })
  updater = createPreviewUpdater({ version: '2.0.0', status, control, stepMs: 0 })
  control.syncStatus()
  return { updater, control, status }
}

test('in notify mode the previewed version waits, then downloads and stages once approved', async (t) => {
  const { updater, control, status } = preview('notify')
  await updater._debouncedUpdate()
  t.is(status.get().state, 'available')
  t.is(status.get().nextVersion, '2.0.0')
  t.ok(status.get().lastCheckedAt, 'the check counts as one that reached the network')

  const seen = []
  status.subscribe((s) => seen.push(s.state))
  t.ok(control.install())
  await updater._debouncedUpdate()
  t.is(status.get().state, 'ready')
  t.ok(seen.includes('downloading'))
  t.is(status.get().progress, null, 'the bar is gone once staged')
})

test('in automatic mode the previewed version downloads on the first pass', async (t) => {
  const { updater, control, status } = preview('automatic')
  await updater._debouncedUpdate()
  t.is(status.get().state, 'ready')
  t.ok(control.mayApply())
  await updater.applyUpdate()
  t.is(updater.applied, true, 'applying changes nothing but the flag')
})
