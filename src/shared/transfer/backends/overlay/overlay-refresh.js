import { makeKeyedCoalescer } from '../../../state/coalesce.js'

// Coalesces owner-side share-files-updated refreshes so a large overlay scan
// (one advertise per file) doesn't trigger a full re-list per file.
export function makeSharesRefresh(emit, { intervalMs = 250, schedule, clear } = {}) {
  const engine = makeKeyedCoalescer(emit, {
    intervalMs,
    keyOf: (spaceId, shareId) => spaceId + '|' + shareId,
    schedule,
    clear,
  })
  return { touch: engine.poke, flush: engine.flush, reset: engine.reset }
}
