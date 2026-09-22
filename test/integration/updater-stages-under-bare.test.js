import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import hid from 'hypercore-id-encoding'
import PearRuntimeUpdater from 'pear-runtime-updater'
import { tmpDir } from '../helpers/bare-tmp.js'
import { waitFor } from '../helpers/bare-poll.js'
import { scaled } from '../helpers/bare-timing.js'
import { replicate } from '../helpers/peer-bee.js'

// Pins that pear-runtime-updater stages a bundle from a Bare process with no Electron and no
// swarm: two in-process Corestores replicated directly stand in for the network. The daemon's OTA
// design rests on this and on the staged file keeping the drive entry's executable flag.

const host = `${Bare.platform}-${Bare.arch}`
const NAME = 'Mirall.AppImage'

async function seedDrive(t, { executable }) {
  const store = new Corestore(tmpDir('updater-seed', t))
  const drive = new Hyperdrive(store)
  await drive.ready()
  await drive.put('/package.json', Buffer.from(JSON.stringify({ version: '9.9.9' })))
  await drive.put(`/by-arch/${host}/app/${NAME}`, Buffer.alloc(4096, 1), { executable })
  t.teardown(async () => { await drive.close(); await store.close() })
  return { store, drive }
}

async function stage(t, { executable }) {
  const seed = await seedDrive(t, { executable })
  const dir = tmpDir('updater-stage', t)
  const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
  replicate(seed.store, store, t)
  const updater = new PearRuntimeUpdater({
    dir,
    app: path.join(dir, NAME),
    bundled: true,
    updates: true,
    version: '0.0.1',
    upgrade: `pear://${hid.encode(seed.drive.key)}`,
    name: NAME,
    store,
    delay: 0,
  })
  // The updater routes every _update failure into an 'error' emit; unheard, that aborts the process.
  updater.on('error', (err) => t.fail(`updater error: ${err.message}`))
  t.teardown(async () => { await updater.close(); await store.close() })
  await updater.ready()
  await updater._debouncedUpdate()
  await waitFor(() => updater.updated, 10000, { label: 'updated' })
  return { dir, updater, staged: path.join(updater.next, 'by-arch', host, 'app', NAME) }
}

test('pear-runtime-updater stages into <dir>/pear-runtime/next under bare', { timeout: scaled(60000) }, async (t) => {
  const { dir, updater, staged } = await stage(t, { executable: true })
  t.ok(updater.next.startsWith(path.join(dir, 'pear-runtime', 'next')), 'staged under pear-runtime/next')
  t.is(updater.nextVersion, '9.9.9')
  t.is(fs.statSync(staged).size, 4096, 'the payload is mirrored whole')
})

test('the staged file carries the executable bit only when the drive entry has it', { skip: Bare.platform === 'win32', timeout: scaled(90000) }, async (t) => {
  const withFlag = await stage(t, { executable: true })
  // S_IXUSR is the bit localdrive sets from the flag; the group/other bits follow the umask.
  t.is(fs.statSync(withFlag.staged).mode & 0o100, 0o100, 'executable entry stages as executable')
  const withoutFlag = await stage(t, { executable: false })
  // A seed that omits the flag leaves the host to chmod before the swap; this is that rule's pin.
  t.is(fs.statSync(withoutFlag.staged).mode & 0o100, 0, 'plain entry stages without the bit')
})
