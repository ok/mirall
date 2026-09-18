// Whether dropping the peer connections would interrupt work in progress.
//
// Asked before a transport change is applied on the user's behalf: a setting flipped while nothing
// is moving is worth applying at once, and the same change during a transfer is worth asking about.
// Both directions count — a download's liveness is its pending row's updatedAt, a serve's is the
// per-peer lastTs on the ledger entry. A row that has not moved inside the window is parked
// (paused, owner offline, errored), and a reconnect is what would unpark it.
import { listPending } from './pending-transfers.js'
import { hasRecentServe } from './serve-ledger.js'

export const TRANSFER_QUIET_MS = 8000

export async function transfersMoving({ now = Date.now(), quietMs = TRANSFER_QUIET_MS, list = listPending, serves = hasRecentServe } = {}) {
  if (serves({ now, quietMs })) return true
  // A store that cannot be read must not block a setting the user asked for.
  const pending = await list().catch(() => [])
  return pending.some((row) => !row.errorCode && now - (row.updatedAt ?? 0) < quietMs)
}
