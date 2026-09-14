// A keyed, single-flighted, debounced scan scaffold.
//
// The first poke per key fires after the debounce; overlapping scans cannot stack, because one
// queued trailing re-run absorbs every poke that lands mid-scan. Nothing here knows what it is
// scanning — the download engine uses it for both its resume (reconnect) and reconcile (append)
// drivers, and it closes over none of the engine's state, which is why it lives out here.

import { makeKeyedCoalescer } from '../../../core/coalesce.js'

// Keyed, single-flighted, debounced scan scaffold: the first poke per (owner, space) fires
// after the debounce; overlapping scans can't stack (one queued trailing re-run absorbs pokes
// that land mid-scan). Shared by the resume (reconnect) and reconcile (append) drivers below.
export function makeSingleFlightScan(fn, log) {
  let inFlight = false
  const queued = new Map()
  const poke = makeKeyedCoalescer((ownerKey, spaceId) => { run(ownerKey, spaceId) },
    { intervalMs: 250, keyOf: (ownerKey, spaceId) => ownerKey + '|' + spaceId })
  async function run(ownerKey, spaceId) {
    if (inFlight) { queued.set(ownerKey + '|' + spaceId, [ownerKey, spaceId]); return }
    inFlight = true
    try { await fn(ownerKey, spaceId) } catch (err) { log.debug('overlay reconcile scan failed:', err.message) }
    finally {
      inFlight = false
      if (queued.size) { const q = [...queued.values()]; queued.clear(); for (const [o, s] of q) poke.flush(o, s) }
    }
  }
  return (ownerKey, spaceId) => poke.poke(ownerKey, spaceId)
}
