// @ts-check
// The network status and relay surface. applyRelayConfig is injected because it belongs to the
// boot root: setting a relay mode has to re-apply it to the live swarm, not just persist it.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { WorkerRoot } from '../boot.js' */
import { setRelayConfig, getRelayConfig, getUpgradeKey } from '../../shared/core/runtime-config.js'
import { relayMismatch } from '../../shared/contract/relay-apply.js'
import { getSwarmStatus, scheduleStatusEmit } from '../../shared/network/network-status.js'
import { reconnectAll } from '../../shared/network/space-topics.js'
import { probeCanary } from '../../shared/network/canary-probe.js'
import { setBrowserOnlineHint } from '../../shared/network/connectivity.js'
import { checkLivenessNow } from '../../shared/network/link-liveness.js'
import { testRelayReachable } from '../../shared/network/relay-install.js'
import { snapshotRelayedConnections } from '../../shared/network/relayed-connections.js'
import { transfersMoving } from '../../shared/transfer/transfer-activity.js'
import { record } from '../../shared/audit/audit-log.js'
import { relayConfigRow } from '../../shared/audit/relay-config-change.js'
import { getSettings, updateSettings } from '../../shared/core/settings-store.js'
import { normalizeRelayMode, sanitizeRelay, sanitizeLastTest } from '../../shared/network/relay-slot.js'
import { Scope } from '../../shared/contract/scope.js'
import { settingsView } from './settings.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'

/** @param {WorkerIpc} ipc @param {{ applyRelayConfig: WorkerRoot['applyRelayConfig'] }} deps */
export function registerNetwork(ipc, { applyRelayConfig }) {
  ipc.handle('network:status:get', async () => getSwarmStatus())
  ipc.handle('network:reconnect', async () => await reconnectAll())

  // Applying the mode is not the same as applying it to the connections that already exist, and the
  // difference is invisible from here: the setting is live either way. When nothing is moving the
  // reconnect is cheap and the user gets what they asked for at once; while a transfer is in flight
  // it is theirs to trigger, so the verdict goes back for the renderer to explain. deferApply is set
  // when a pinned identity is waiting on a restart — no reconnect can apply that, and the worker
  // installs no private relay until it has. Only that restart clears it: a renderer reloaded in the
  // meantime has forgotten, but this node still presents the old identity.
  //
  // The slot is persisted here, after sanitizing, and before it is applied: the Activity Log row
  // diffed below records a saved change and never a refused one. An omitted mode or relay keeps the
  // stored one, a null relay clears it, and lastTest patches the stored slot with a probe verdict.
  // Only a pinned identity coming or going needs the DHT node rebuilt, which the renderer does by
  // restarting the worker once the seed vault and this slot agree.
  ipc.handle('network:set-relay', async (msg) => {
    if (msg.mode === undefined && msg.relay === undefined && msg.lastTest === undefined) {
      throw new AppError(CODES.INVALID_ARGUMENT, 'network:set-relay: nothing to change')
    }
    const before = getRelayConfig()
    const stored = getSettings().network
    const mode = msg.mode === undefined ? stored.relayMode : normalizeRelayMode(msg.mode)
    let relay = msg.relay === undefined ? stored.relay : sanitizeRelay(msg.relay)
    // A slot that does not decode is refused, never stored as "no relay": the stored slot and the
    // vaulted seed stay as they were.
    if (msg.relay && relay === null) throw new AppError(CODES.INVALID_ARGUMENT, 'network:set-relay: not a relay key')
    if (relay && msg.lastTest !== undefined) relay = { ...relay, lastTest: sanitizeLastTest(msg.lastTest) }
    await updateSettings((s) => { s.network.relayMode = mode; s.network.relay = relay; return s })
    const identityPending = before.identityPending || msg.deferApply === true
    setRelayConfig(mode, relay, { identityPending })
    const applied = applyRelayConfig()
    const after = getRelayConfig()
    const change = relayConfigRow(before, after)
    if (change) record(change.kind, change.row)
    // A connection's `replaced` flag follows the slot, and no connection event reports a slot change.
    scheduleStatusEmit()
    ipc.emit('event:reconcile', { scope: Scope.settings() })
    // Only a slot write can pin or unpin an identity; a mode change or a probe verdict never does.
    const identityChanged = msg.relay !== undefined && (before.relay?.kind === 'private' || relay?.kind === 'private')
    const verdict = { ok: /** @type {const} */ (true), ...applied, identityChanged, network: settingsView().network }
    const mismatch = relayMismatch(after.mode, snapshotRelayedConnections())
    if (!mismatch || identityPending) return { ...verdict, mismatch, reconnected: false }
    if (await transfersMoving()) return { ...verdict, mismatch, reconnected: false }
    const res = await reconnectAll()
    return { ...verdict, mismatch, reconnected: res.ok === true }
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
