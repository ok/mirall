// Boot both swarms the way the boot root does: Swarm, then ContentSwarm, then apply the relay. The
// order is the point — getContentSwarm() is null until the second constructor returns.
import { localTestnet } from './testnet.js'
import { createFakeIpc } from './fake-ipc.js'
import { stubOverlayBackend } from './overlay-stub.js'
import path from 'bare-path'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { loadSettings } from '../../src/shared/core/settings-store.js'
import { tmpDir } from './bare-tmp.js'
import { Swarm } from '../../src/shared/network/swarm.js'
import { ContentSwarm } from '../../src/shared/network/content-swarm.js'

export async function bootSwarms(t, { relayMode = 'off', relay = null, relaySeedHex = null } = {}) {
  const bootstrap = await localTestnet(t)
  await loadSettings(path.join(tmpDir('swarms', t), 'app-storage'))
  setRuntimeConfig({ storage: null, dhtBootstrap: bootstrap, relayMode, relay })
  const fake = createFakeIpc()
  const ipc = fake.ipc
  const swarm = new Swarm('swarm', { ipc, membershipControl: async () => {}, overlayBackend: stubOverlayBackend, stalledOwners: () => [], relaySeedHex })
  const content = new ContentSwarm('content-swarm', { swarm, overlayBackend: stubOverlayBackend })
  t.teardown(async () => {
    try { await content.close() } catch {}
    try { await swarm.close() } catch {}
  })
  await swarm.ready()
  await content.ready()
  return { swarm, content, bootstrap, ipc, ipcEvents: fake.events }
}
