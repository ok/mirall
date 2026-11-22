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
const { createUpdatePolicy } = require('../../src/main/update-policy.js')

// The update mode against a real updater, wired as main wires it: the policy's gate is the
// updater's skipUpdate hook and its mayInstall guards the apply. Outside automatic mode a newer
// version is read and reported, and none of its blocks reach the device until that version is
// approved; a staged update installs only while the policy allows it.

const host = `${process.platform}-${process.arch}`
const NAME = 'Mirall.AppImage'
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

async function setup(t, { remote, mode }) {
  const seedStore = new Corestore(tmpDir('update-mode-seed', t))
  const seed = new Hyperdrive(seedStore)
  await seed.ready()
  t.teardown(async () => { await seed.close(); await seedStore.close() })
  await seed.put('/package.json', Buffer.from(JSON.stringify({ version: remote })))
  await seed.put(PREFIX, PAYLOAD)

  const dir = tmpDir('update-mode-stage', t)
  const app = path.join(dir, NAME)
  fs.writeFileSync(app, 'running build')
  const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
  replicate(seedStore, store, t)

  const state = { mode, manual: false, reported: [] }
  const policy = createUpdatePolicy({ running: '1.0.0', getMode: () => state.mode })
  let updater = null
  const skipUpdate = async () => {
    const decision = await policy.gate(updater.drive, { manual: state.manual })
    if (decision === null) return false
    if (decision.available !== undefined) state.reported.push(decision.available)
    return decision.skip
  }
  updater = new PearRuntimeUpdater({
    dir, app, bundled: true, updates: true, version: '1.0.0',
    upgrade: `pear://${hid.encode(seed.key)}`, name: NAME, store, delay: 0, skipUpdate,
  })
  updater.on('error', (err) => t.fail(`updater error: ${err.message}`))
  t.teardown(async () => { await updater.close(); await store.close() })
  await updater.ready()
  // The updater's own pass at open runs before the drive has replicated: it is not under test.
  await updater._updating
  state.reported.length = 0
  await updater.drive.update({ wait: true })
  const install = () => (policy.mayInstall(updater.nextVersion) ? updater.applyUpdate() : null)
  const installed = () => fs.readFileSync(app, 'utf8') !== 'running build'
  return { seed, updater, policy, state, install, installed }
}

test('notify reports a newer version and fetches none of it until it is approved', { timeout: scaled(60000) }, async (t) => {
  const { seed, updater, policy, state } = await setup(t, { remote: '2.0.0', mode: 'notify' })
  await updater._debouncedUpdate()
  t.alike(state.reported, ['2.0.0'], 'the version was read and reported')
  t.is(updater.updated, false, 'nothing was staged')
  t.is((await payloadBlocksHere(updater, seed)).here, 0, 'no block of the update is on the device')

  policy.approve('2.0.0')
  await updater._debouncedUpdate()
  await waitFor(() => updater.updated, scaled(10000), { label: 'staged' })
  const { here, total } = await payloadBlocksHere(updater, seed)
  t.is(here, total, 'the approved update downloaded whole')
  t.is(updater.nextVersion, '2.0.0')
})

test('never keeps a background pass from reading anything, and Check now still finds the version', { timeout: scaled(60000) }, async (t) => {
  const { seed, updater, state } = await setup(t, { remote: '2.0.0', mode: 'never' })
  await updater._debouncedUpdate()
  t.alike(state.reported, [], 'the background pass decided without reading')
  state.manual = true
  await updater._debouncedUpdate()
  t.alike(state.reported, ['2.0.0'], 'the check the user asked for read it')
  t.is((await payloadBlocksHere(updater, seed)).here, 0, 'and fetched none of it')
})

test('a build that is current reports nothing and prefetches nothing', { timeout: scaled(60000) }, async (t) => {
  const { seed, updater, state } = await setup(t, { remote: '1.0.0', mode: 'notify' })
  await updater._debouncedUpdate()
  t.alike(state.reported, [null])
  t.is((await payloadBlocksHere(updater, seed)).here, 0, 'the copy of the running build is not prefetched')
})

test('an update staged in automatic mode does not install once updates are switched off', { timeout: scaled(60000) }, async (t) => {
  const { updater, policy, state, install, installed } = await setup(t, { remote: '2.0.0', mode: 'automatic' })
  await updater._debouncedUpdate()
  await waitFor(() => updater.updated, scaled(10000), { label: 'staged' })
  state.mode = 'notify'
  t.is(install(), null, 'the quit sequence gets nothing to apply')
  t.absent(installed(), 'the running build is still in place')

  policy.approve('2.0.0')
  await install()
  t.ok(installed(), 'Update installs it')
})
