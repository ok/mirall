// The probe-to-action rule for supervised units, kept pure and separate from the driver: a policy
// that can only be exercised by running a real subsystem is a policy nothing asserts.
//
// Three guards, each of which a hand-built probe had to reinvent:
//   consecutiveBad — one slow sample must not recover work that is merely busy
//   maxRecoveries  — a unit that cannot be recovered is stated once, not recovered forever
//   pruning        — a unit that disappeared drops its counters, or the next unit to reuse the key
//                    inherits a spent budget
export const DEFAULT_POLICY = { consecutiveBad: 2, maxRecoveries: 3 }

export function createSupervisionPolicy(overrides = {}) {
  const bad = new Map()
  const spent = new Map()
  const gaveUp = new Set()

  function limitsFor(name) {
    return { ...DEFAULT_POLICY, ...(overrides[name] || {}) }
  }

  function prune(rows) {
    const live = new Set(rows.map((row) => row.id))
    for (const id of [...bad.keys()]) if (!live.has(id)) bad.delete(id)
    for (const id of [...spent.keys()]) if (!live.has(id)) spent.delete(id)
    for (const id of [...gaveUp]) if (!live.has(id)) gaveUp.delete(id)
  }

  // Rows: { id, name, key, ok, detail }. Returns a decision per row that needs one, with `action`
  // in 'note' | 'recover' | 'gave-up'. The counters are mutated here, so a caller that evaluates
  // and then declines to act leaves the unit permanently one probe short of its recovery.
  function evaluate(rows) {
    prune(rows)
    const out = []
    for (const row of rows) {
      if (row.ok) { bad.delete(row.id); continue }
      const limits = limitsFor(row.name)
      const n = (bad.get(row.id) || 0) + 1
      bad.set(row.id, n)
      if (n < limits.consecutiveBad) {
        out.push({ row, action: 'note', badCount: n, badLimit: limits.consecutiveBad })
        continue
      }
      const used = spent.get(row.id) || 0
      if (used >= limits.maxRecoveries) {
        if (!gaveUp.has(row.id)) {
          gaveUp.add(row.id)
          out.push({ row, action: 'gave-up', spentCount: used })
        }
        continue
      }
      spent.set(row.id, used + 1)
      // Cleared, not decremented: a unit that recovers and re-stalls starts a fresh streak, so it
      // spends its next strike a full window later rather than on the first probe after recovery.
      bad.delete(row.id)
      out.push({ row, action: 'recover', spentCount: used + 1 })
    }
    return out
  }

  return {
    evaluate,
    stats() {
      return {
        recoveries: Object.fromEntries(spent),
        unhealthy: Object.fromEntries(bad),
        gaveUp: [...gaveUp],
      }
    },
  }
}
