// The network status and relay surface. applyRelayConfig is injected because it belongs to the
// boot root: setting a relay mode has to re-apply it to the live swarm, not just persist it.

import { setRelayConfig, getUpgradeKey } from '../../shared/core/runtime-config.js'
import { relayMismatch } from '../../shared/contract/relay-apply.js'
import { getSwarmStatus } from '../../shared/network/network-status.js'
import { reconnectAll } from '../../shared/network/space-topics.js'
import { probeCanary } from '../../shared/network/canary-probe.js'
import { setBrowserOnlineHint } from '../../shared/network/connectivity.js'
import { checkLivenessNow } from '../../shared/network/link-liveness.js'
import { testRelayReachable } from '../../shared/network/relay-install.js'
import { snapshotRelayedConnections } from '../../shared/network/relayed-connections.js'
import { transfersMoving } from '../../shared/transfer/transfer-activity.js'

export function registerNetwork(ipc, { applyRelayConfig }) {
  ipc.handle('network:status:get', async () => getSwarmStatus())
  ipc.handle('network:reconnect', async () => await reconnectAll())

  // Applying the mode is not the same as applying it to the connections that already exist, and the
  // difference is invisible from here: the setting is live either way. When nothing is moving the
  // reconnect is cheap and the user gets what they asked for at once; while a transfer is in flight
  // it is theirs to trigger, so the verdict goes back for the renderer to explain. deferApply is set
  // when a pinned identity is waiting on a restart — no reconnect can apply that.
  ipc.handle('network:set-relay', async (msg) => {
    setRelayConfig(msg?.mode, msg?.relay)
    const applied = applyRelayConfig()
    const mismatch = relayMismatch(msg?.mode, snapshotRelayedConnections())
    if (!mismatch || msg?.deferApply) return { ok: true, ...applied, mismatch, reconnected: false }
    if (await transfersMoving()) return { ok: true, ...applied, mismatch, reconnected: false }
    const res = await reconnectAll()
    return { ok: true, ...applied, mismatch, reconnected: res.ok === true }
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
