// Bringing the live connections in line with a relay setting just applied. The status frame's
// `replaced` flags follow the slot at once; a mode the open connections contradict reconnects them,
// unless a transfer is moving (the person's to trigger) or a pinned identity waits on a restart,
// which no reconnect can apply.
import { getRelayConfig } from '../core/runtime-config.js'
import { relayMismatch } from '../contract/relay-apply.js'
import { scheduleStatusEmit } from './network-status.js'
import { reconnectAll } from './space-topics.js'
import { snapshotRelayedConnections } from './relayed-connections.js'
import { transfersMoving } from '../transfer/transfer-activity.js'

export async function followRelayConfig() {
  scheduleStatusEmit()
  const { mode, identityPending } = getRelayConfig()
  const mismatch = relayMismatch(mode, snapshotRelayedConnections())
  if (!mismatch || identityPending || await transfersMoving()) return { mismatch, reconnected: false }
  const res = await reconnectAll()
  return { mismatch, reconnected: res.ok === true }
}
