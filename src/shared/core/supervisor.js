// Polls every started subsystem's supervisable units and recovers the ones the policy condemns.
// Started LAST so the lifecycle's reverse close order stops it FIRST — structural, rather than a
// line in the shutdown path someone has to remember.
//
// It recovers a UNIT inside a subsystem, never a subsystem: closing one and constructing another
// hands every holder that captured it a dead instance, and the subsystems worth supervising are
// exactly the ones where close() means something other than "pause" — one stops every mirror loop
// and starts none, another resets its module collaborators to no-ops while the swarm is live.
//
// Recoveries are narrow on purpose. A recovery broader than the fault is itself the outage: a
// peer's socket is the single mux carrying every core and transfer for that peer, a Corestore-backed
// handle belongs to whoever closes it, and a close() that awaits the stalled pass never settles. A
// recovery abandons; it does not drain.
import { Subsystem } from './subsystem.js'
import { createSupervisionPolicy, DEFAULT_POLICY } from './supervision.js'
import { getSupervisionProbeIntervalMs } from './runtime-config.js'

export class Supervisor extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('lifecycle')
    this.paused = false
    this.probing = false
    this.overrides = {}
    this.policy = createSupervisionPolicy(this.overrides)
  }

  async _open() {
    this.timers.setInterval(() => {
      this.probe().catch((err) => this.log.debug('supervision probe failed:', err.message))
    }, getSupervisionProbeIntervalMs())
  }

  // Stops probing without closing. The shutdown path runs three steps and a flush window BEFORE
  // life.close() reaches this subsystem, and no subsystem's `stopping` is set in that window — a
  // probe firing there reads a healthy lifecycle and could re-arm work the shutdown just stopped.
  pause() { this.paused = true }

  collectRows() {
    const rows = []
    for (const subsystem of this.deps.lifecycle.started) {
      if (subsystem === this || subsystem.stopping || subsystem.closed) continue
      let units = []
      try {
        units = subsystem.supervise() || []
      } catch (err) {
        this.log.warn(subsystem.name, 'supervise() failed:', err.message)
        continue
      }
      if (!units.length) continue
      if (subsystem.supervisionPolicy) this.overrides[subsystem.name] = subsystem.supervisionPolicy
      for (const unit of units) {
        rows.push({ ...unit, name: subsystem.name, id: subsystem.name + ' ' + unit.key, subsystem })
      }
    }
    return rows
  }

  async probe() {
    // A probe overlapping its own recovery would abandon a pass twice. Skipped, not queued: the
    // next probe is a full interval away and the state it reads will be fresher.
    if (this.paused || this.stopping || this.probing) return
    this.probing = true
    try {
      for (const decision of this.policy.evaluate(this.collectRows())) {
        if (!this.actOn(decision)) continue
        // Re-checked inside the loop, not only at entry: this awaits, so a shutdown can begin
        // between two units and the second recovery would re-arm work the teardown already stopped.
        if (this.paused || this.stopping || decision.row.subsystem.stopping) return
        const { row } = decision
        this.log.warn('recovering', row.name, row.label || row.key, '-', row.detail || '')
        try {
          await row.subsystem.recover(row.key)
        } catch (err) {
          this.log.warn('recovery failed for', row.name, row.label || row.key, '-', err.message)
        }
      }
    } finally {
      this.probing = false
    }
  }

  // Logs the non-acting decisions; returns true only for the ones that need a recovery.
  actOn({ row, action, badCount, badLimit, spentCount }) {
    if (action === 'note') {
      const limit = badLimit ?? DEFAULT_POLICY.consecutiveBad
      this.log.warn('unhealthy:', row.name, row.label || row.key, '-', row.detail || '', `(${badCount}/${limit})`)
      return false
    }
    if (action === 'gave-up') {
      this.log.error(row.name, 'still unhealthy after', spentCount, 'recoveries — leaving it down:',
        row.label || row.key, '-', row.detail || '')
      return false
    }
    return true
  }

  // Counts by subsystem name only. This reaches the shareable diagnostics bundle and unit keys
  // carry space and share ids; the worker log is where a unit is named.
  stats() {
    const raw = this.policy.stats()
    const tally = (ids) => {
      const out = {}
      for (const [id, n] of ids) {
        const name = id.slice(0, id.indexOf(' '))
        out[name] = (out[name] || 0) + n
      }
      return out
    }
    return {
      recoveries: tally(Object.entries(raw.recoveries)),
      unhealthy: tally(Object.entries(raw.unhealthy)),
      gaveUp: tally(raw.gaveUp.map((id) => [id, 1])),
    }
  }

  async _close() { this.paused = true }
}
