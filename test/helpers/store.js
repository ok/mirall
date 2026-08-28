import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { initStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { initProfile, setProfile } from '../../src/shared/spaces/profile.js'
import { initSpaces } from '../../src/shared/spaces/space.js'
import { initMounts } from '../../src/shared/folders/mount-store.js'
import { initOwnedFolders, _resetOwnedFolders } from '../../src/shared/folders/owned-folders.js'
import { initForeignFolders } from '../../src/shared/folders/foreign-folders.js'
import { createFakeIpc } from './fake-ipc.js'

let seq = 0
function tmpDir (label) {
  const rand = Math.random().toString(36).slice(2, 8)
  const dir = path.join(os.tmpdir(), `mirall-test-${label}-${Date.now()}-${rand}-${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Spin up a clean single-peer backend against a fresh on-disk store + download
// dir, with the shared modules initialised and a fake ipc. NOTE: src/shared
// modules are process-global singletons — one peer per test process; the
// integration files are loaded one-per-thread under `brittle-bare -j`.
export async function freshPeer (t, { displayName = 'Tester' } = {}) {
  return bootPeer(t, { displayName, masterSecret: null })
}

// Same as freshPeer but on the explicit-keypair identity path (a random master
// secret stands in for a resolved M), so the integration suite exercises the
// derived-keypair createBee/createDrive that the os-keychain path produces.
export async function freshPeerWithIdentity (t, { displayName = 'Tester' } = {}) {
  return bootPeer(t, { displayName, masterSecret: crypto.randomBytes(32) })
}

async function bootPeer (t, { displayName, masterSecret }) {
  const storage = tmpDir('store')
  const downloads = tmpDir('dl')
  setRuntimeConfig({ storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads })
  setDownloadFolder(downloads)

  initStore(storage)
  setMasterSecret(masterSecret)
  await initProfile()
  await setProfile({ displayName })          // gives the profile bee a stable identity
  await initSpaces()
  await initMounts()

  const fake = createFakeIpc()
  initOwnedFolders(fake.ipc)
  initForeignFolders(fake.ipc)

  t.teardown(async () => {
    try { await _resetOwnedFolders() } catch {}
    try { await getStore().close() } catch {}
    try { fs.rmSync(storage, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(downloads, { recursive: true, force: true }) } catch {}
  })

  return { storage, downloads, fake, tmpDir }
}
