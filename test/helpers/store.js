import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { setProfile } from '../../src/shared/spaces/profile.js'
import { boot, bootDurable } from '../../src/worker/boot.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { _resetContentBackendOverlay } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { _resetLooseOverlay } from '../../src/shared/transfer/loose-overlay.js'
import { createFakeIpc } from './fake-ipc.js'

let seq = 0
function tmpDir (label) {
  const rand = Math.random().toString(36).slice(2, 8)
  const dir = path.join(os.tmpdir(), `mirall-test-${label}-${Date.now()}-${rand}-${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const quiet = { debug () {}, info () {}, warn () {}, error () {} }

// Production layout: the store sits at <peerDir>/app-storage, so identity.enc and space-keys.enc —
// which the worker writes to dirname(storage) — land in THIS peer's directory rather than in a
// tmpdir shared with every other peer of every other test.
function peerDirs (t) {
  const home = tmpDir('peer')
  const storage = path.join(home, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmpDir('dl')
  const config = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads }
  setRuntimeConfig(config)
  setDownloadFolder(downloads)
  t.teardown(() => {
    for (const dir of [home, downloads]) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }, { order: 2 })
  return { config, storage, downloads }
}

// Spin up a clean single-peer backend: the whole data layer, composed exactly as the worker
// composes it, minus the network. NOTE: src/shared modules are process-global singletons — one
// peer per test process; the integration files are loaded one-per-thread under `brittle-bare -j`.
export async function freshPeer (t, { displayName = 'Tester' } = {}) {
  return bootPeer(t, { displayName, masterSecret: null })
}

// Same as freshPeer but on the explicit-keypair identity path (a random master secret stands in
// for a resolved M), so the suite exercises the derived-keypair createBee/createDrive that the
// os-keychain path produces.
export async function freshPeerWithIdentity (t, { displayName = 'Tester' } = {}) {
  return bootPeer(t, { displayName, masterSecret: crypto.randomBytes(32) })
}

async function bootPeer (t, { displayName, masterSecret }) {
  const { config, storage, downloads } = peerDirs(t)
  const fake = createFakeIpc()
  const root = await boot(config, { ipc: fake.ipc, log: quiet, swarm: false, masterSecret })
  await setProfile({ displayName })
  // order:1 — brittle sorts teardowns and runs the default order:0 ones first, so a test's own
  // teardown still has a live data layer to work against. Closing the root first would leave every
  // bee accessor pointing at nothing.
  t.teardown(async () => {
    try { await root.close() } catch (err) { console.warn('[test] root.close failed:', err.message) }
    // Started by boot() but not yet owned by it — the overlay modules Phase 3 converts.
    try { _resetContentBackendOverlay() } catch {}
    try { _resetLooseOverlay() } catch {}
    try { serveIndex._reset() } catch {}
  }, { order: 1 })
  return { storage, downloads, fake, tmpDir, root }
}

// The durable tier alone, for a test whose subject is what boot() does AFTER it — a content
// migration, the manifest caps — which must not already have run.
export async function freshDurableWithIdentity (t, opts = {}) {
  return freshDurable(t, { ...opts, masterSecret: crypto.randomBytes(32) })
}

export async function freshDurable (t, { displayName = 'Tester', masterSecret = null, storage = null } = {}) {
  let config
  let dirs
  if (storage) {
    const downloads = tmpDir('dl')
    t.teardown(() => { try { fs.rmSync(downloads, { recursive: true, force: true }) } catch {} }, { order: 2 })
    config = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads }
    setRuntimeConfig(config)
    setDownloadFolder(downloads)
    dirs = { config, storage, downloads }
  } else {
    dirs = peerDirs(t)
  }
  const fake = createFakeIpc()
  const tier = await bootDurable(dirs.config, { ipc: fake.ipc, log: quiet, masterSecret })
  if (displayName) await setProfile({ displayName })
  t.teardown(() => tier.close(), { order: 1 })
  return { storage: dirs.storage, downloads: dirs.downloads, fake, tmpDir, tier }
}
