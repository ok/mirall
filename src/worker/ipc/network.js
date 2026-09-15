// The network status and relay surface. applyRelayConfig is injected because it belongs to the
// boot root: setting a relay mode has to re-apply it to the live swarm, not just persist it.

import { setRelayConfig, getUpgradeKey } from '../../shared/core/runtime-config.js'
import { getSwarmStatus } from '../../shared/network/network-status.js'
import { reconnectAll } from '../../shared/network/space-topics.js'
import { probeCanary } from '../../shared/network/canary-probe.js'
import { setBrowserOnlineHint } from '../../shared/network/connectivity.js'
import { checkLivenessNow } from '../../shared/network/link-liveness.js'
import { testRelayReachable } from '../../shared/network/relay-install.js'

export function registerNetwork(ipc, { applyRelayConfig }) {
  ipc.handle('network:status:get', async () => getSwarmStatus())
  ipc.handle('network:reconnect', async () => await reconnectAll())

  ipc.handle('network:set-relay', async (msg) => {
    setRelayConfig(msg?.mode, msg?.relay)
    return { ok: true, ...applyRelayConfig() }
  })

  ipc.handle('network:test-relay', async (msg) => await testRelayReachable(msg?.publicKey))

  ipc.handle('network:probe-canary', async (msg) =>
    await probeCanary(getUpgradeKey(), { force: !!msg?.force }))

  // The renderer owns navigator.onLine; the worker cannot see it. Without this a pulled
  // cable would be classified as a NAT problem.
  ipc.handle('network:online-hint', async (msg) => {
    setBrowserOnlineHint(msg?.online !== false)
    return { ok: true }
  })

  ipc.handle('network:check-liveness', async () => await checkLivenessNow())
}
