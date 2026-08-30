// Per-request rollups the router already has the inputs for: it times every request and, before
// this, threw the number away. Four counts per request answer the three questions worth asking —
// which request is slow, how often it fails, how many are in flight.
//
// Bounded by the request vocabulary, which is a closed set of 86 since the contract package landed,
// so this needs no cap. The failure counters in ipc.js DO have one, because their key includes a
// caller-supplied type.
export function createRequestMetrics ({ now = Date.now, slowMs = 1000 } = {}) {
  const rows = new Map()

  function rowFor (type) {
    let row = rows.get(type)
    if (!row) rows.set(type, (row = { calls: 0, failures: 0, totalMs: 0, maxMs: 0, slow: 0, inFlight: 0 }))
    return row
  }

  return {
    begin (type) {
      const row = rowFor(type)
      row.inFlight += 1
      const startedAt = now()
      let settled = false
      return function settle (ok) {
        // A handler that both resolves and throws would otherwise double-count, and that bug is
        // exactly what this would hide.
        if (settled) return 0
        settled = true
        const ms = now() - startedAt
        row.inFlight -= 1
        row.calls += 1
        row.totalMs += ms
        if (ms > row.maxMs) row.maxMs = ms
        if (ms >= slowMs) row.slow += 1
        if (!ok) row.failures += 1
        return ms
      }
    },

    snapshot () {
      const out = {}
      for (const [type, row] of rows) {
        out[type] = {
          calls: row.calls,
          failures: row.failures,
          inFlight: row.inFlight,
          avgMs: row.calls ? Math.round(row.totalMs / row.calls) : 0,
          maxMs: row.maxMs,
          slow: row.slow,
        }
      }
      return out
    },

    reset () { rows.clear() },
  }
}
