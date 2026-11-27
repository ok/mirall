import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import hid from 'hypercore-id-encoding'
import PearRuntimeUpdater from 'pear-runtime-updater'
import { tmpDir } from '../helpers/tmp.js'
import { scaled } from '../helpers/timing.js'
import { waitFor } from '../helpers/poll.js'

const require = createRequire(import.meta.url)
const { createUpdateModeControl } = require('../../src/main/update-mode.js')
const { initialUpdateStatus, createUpdateStatus } = require('../../src/main/update-status.js')
const { ConfigStore } = require('../../src/main/config-store.js')

// The update mode against a real updater, wired as main wires it: the mode control's gate is the
// updater's skipUpdate hook, its `staged` follows the updater's `updated` event, and its `mayApply`
// guards the apply. Outside automatic mode a newer version is read and reported, and none of its
// blocks reach the device until that version is approved; a staged update installs only while the
// mode allows it.

const host = `${process.platform}-${process.arch}`
// A file the updater swaps in place on this system: on Windows it applies only an .exe that way.
const NAME = process.platform === 'win32' ? 'Mirall.exe' : 'Mirall.AppImage'
const PREFIX = `/by-arch/${host}/app/${NAME}`
const PAYLOAD = Buffer.alloc(64 * 1024 * 16, 7)

function replicate(a, b, t) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() })
}

async function payloadBlocksHere(updater, seed) {
  const { blob } = (await seed.entry(PREFIX)).value
  const blobs = await updater.drive.getBlobs()
  let here = 0
  for (let i = blob.blockOffset; i < blob.blockOffset + blob.blockLength; i++) if (await blobs.core.has(i)) here++
  return { here, total: blob.blockLength }
}

async function setup(t, { remote, mode, prestages = false }) {
  const seedStore = new Corestore(tmpDir('update-mode-seed', t))
  const seed = new Hyperdrive(seedStore)
  await seed.ready()
  t.teardown(async () => { await seed.close(); await seedStore.close() })
  const publish = async (version) => {
    await seed.put(PREFIX, Buffer.concat([PAYLOAD, Buffer.from(version)]))
    await seed.put('/package.json', Buffer.from(JSON.stringify({ version })))
  }
  await publish(remote)

  const dir = tmpDir('update-mode-stage', t)
  const app = path.join(dir, NAME)
  fs.writeFileSync(app, 'running build')
  const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
  replicate(seedStore, store, t)

  const config = new ConfigStore(tmpDir('update-mode-config', t)).load()
  config.set('updates.mode', mode)
  const status = createUpdateStatus(initialUpdateStatus({ offReason: null, canRestart: false }))
  let updater = null
  const control = createUpdateModeControl({
    running: '1.0.0',
    config: () => config,
    status,
    getUpdater: () => updater,
    prestages,
    runUserPass: (u) => u._debouncedUpdate(),
  })
  updater = new PearRuntimeUpdater({
    dir, app, bundled: true, updates: true, version: '1.0.0',
    upgrade: `pear://${hid.encode(seed.key)}`, name: NAME, store, delay: 0, skipUpdate: control.gatePass,
  })
  updater.on('error', (err) => t.fail(`updater error: ${err.message}`))
  updater.on('updating', () => status.dispatch({ type: 'downloading' }))
  updater.on('updated', () => control.staged())
  t.teardown(async () => { await updater.close(); await store.close() })
  await updater.ready()
  // The updater's own pass at open runs before the drive has replicated: it is not under test.
  await updater._updating
  await updater.drive.update({ wait: true })
  control.syncStatus()
  const pass = async () => {
    await updater._debouncedUpdate()
    status.dispatch({ type: 'pass-end', reached: true, manual: false })
  }
  const staged = (version) => waitFor(() => updater.updated && updater.nextVersion === version, 10000, { label: `${version} staged` })
  const apply = () => (control.mayApply() ? updater.applyUpdate() : null)
  const installed = () => fs.readFileSync(app, 'utf8') !== 'running build'
  return { seed, publish, updater, control, status, config, pass, staged, apply, installed }
}

test('notify reports a newer version and fetches none of it until it is approved', { timeout: scaled(60000) }, async (t) => {
  const { seed, updater, control, status, pass, staged } = await setup(t, { remote: '2.0.0', mode: 'notify' })
  await pass()
  t.is(status.get().state, 'available')
  t.is(status.get().nextVersion, '2.0.0', 'the version was read and reported')
  t.is(updater.updated, false, 'nothing was staged')
  t.is((await payloadBlocksHere(updater, seed)).here, 0, 'no block of the update is on the device')

  t.ok(control.install(), 'Update is taken')
  await staged('2.0.0')
  const { here, total } = await payloadBlocksHere(updater, seed)
  t.is(here, total, 'the approved update downloaded whole')
  t.is(status.get().state, 'ready')
  t.absent(control.install(), 'nothing is waiting any more')
})

test('a build that is current reports nothing and prefetches nothing', { timeout: scaled(60000) }, async (t) => {
  const { seed, updater, status, pass } = await setup(t, { remote: '1.0.0', mode: 'notify' })
  await pass()
  t.is(status.get().state, 'idle')
  t.is(status.get().nextVersion, null)
  t.is((await payloadBlocksHere(updater, seed)).here, 0, 'the copy of the running build is not prefetched')
})

test('an update staged in automatic mode does not install once the mode is notify', { timeout: scaled(60000) }, async (t) => {
  const { updater, control, status, config, pass, staged, apply, installed } = await setup(t, { remote: '2.0.0', mode: 'automatic' })
  await pass()
  await staged('2.0.0')
  t.is(status.get().state, 'ready')

  control.changeMode('notify')
  t.is(status.get().state, 'available', 'the staged update waits for the user')
  t.is(apply(), null, 'the quit sequence gets nothing to apply')
  t.absent(installed(), 'the running build is still in place')

  t.ok(control.install())
  t.is(status.get().state, 'ready', 'one already staged is ready at once')
  await apply()
  t.ok(installed(), 'Update installs it')
  t.is(updater.applied, true)

  config.set('general', { minimizeToTray: false, openAtLogin: false, firstHideNoticeShown: true, appMenuAutoHide: false })
  config.flush()
  t.is(new ConfigStore(path.dirname(config._file)).load().get('updates.mode'), 'notify', 'the mode outlives a general record written back whole')
})

test('an approved download reads as downloading throughout, and is not held behind an older staged version', { timeout: scaled(60000) }, async (t) => {
  const { publish, updater, control, status, pass, staged } = await setup(t, { remote: '2.0.0', mode: 'automatic' })
  await pass()
  await staged('2.0.0')
  control.changeMode('notify')
  await publish('3.0.0')
  await updater.drive.update({ wait: true })
  await pass()
  t.is(status.get().nextVersion, '3.0.0', 'the newer version is the one offered')
  t.is(status.get().state, 'available')

  const seen = []
  const stop = status.subscribe((s) => seen.push(`${s.state}${s.held ? ':held' : ''}`))
  t.ok(control.install())
  await staged('3.0.0')
  stop()
  t.ok(seen.includes('downloading'), 'the download showed')
  t.absent(seen.includes('checking'), 'no check shows between Update and ready')
  t.absent(seen.some((entry) => entry.endsWith(':held')), 'the approved download never reads as held')
  t.is(seen.at(-1), 'ready')
})

test('where a staged update is put in place early, Update applies an approved one at once', { timeout: scaled(60000) }, async (t) => {
  const { control, pass, staged, installed } = await setup(t, { remote: '2.0.0', mode: 'automatic', prestages: true })
  control.changeMode('notify')
  await pass()
  t.absent(installed(), 'nothing is applied before the go-ahead')
  t.ok(control.install())
  await staged('2.0.0')
  await waitFor(installed, 10000, { label: 'applied in place' })
  t.pass('the approved update was applied without a quit')
})

test('back in automatic mode a version that waited downloads on its own', { timeout: scaled(60000) }, async (t) => {
  const { control, status, pass, staged } = await setup(t, { remote: '2.0.0', mode: 'notify' })
  await pass()
  t.is(status.get().state, 'available')
  control.changeMode('automatic')
  await staged('2.0.0')
  t.is(status.get().state, 'ready')
  t.is(status.get().mode, 'automatic')
})
