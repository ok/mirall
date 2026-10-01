// Brings every restored own bee — the profile, and the own catalogs a backup restore brought back — up
// to the copies peers hold, and lifts each one's hold once they match (restore-hold-rules.js). A
// catalog's holders are its space's members; the profile's are everyone in any space. A released
// catalog reopens writable at once. The profile stays read-only in this worker: restore mode skipped
// every boot step that writes it, and the next, normal boot runs them in order.
import { Subsystem } from '../shared/core/subsystem.js'
import { releaseHeld, heldNames, PROFILE_BEE } from '../shared/core/restore-hold.js'
import { releaseVerdict } from '../shared/core/restore-hold-rules.js'
import { RESTORE_VERDICT } from '../shared/contract/restore-verdict.js'
import { getRestoreReleaseDwellMs } from '../shared/core/runtime-config.js'
import { createBee } from '../shared/core/store.js'
import { listSpaces } from '../shared/spaces/space.js'
import { getLocalPublicKeyHex } from '../shared/spaces/profile.js'
import { catalogNameForSpace, reopenOwnCatalog } from '../shared/shares/own-catalog.js'

const TICK_MS = 2000

function coMembers(spaces, self, spaceId) {
  const keys = new Set()
  for (const space of spaces) {
    if (spaceId !== null && space.spaceId !== spaceId) continue
    for (const member of space.members || []) if (member.publicKey !== self) keys.add(member.publicKey)
  }
  return keys.size
}

export class RestoreCatchUp extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('profile') }

  async _open() {
    const spaces = await listSpaces()
    this.trackers = []
    this.ticking = false
    for (const name of heldNames()) {
      const space = name === PROFILE_BEE ? null : spaces.find((s) => catalogNameForSpace(s.spaceId, s) === name)
      // Only blocks are moved here, never read, so a catalog needs no space key to catch up.
      const bee = name === PROFILE_BEE ? this.deps.profile.bee : createBee(name)
      await bee.core.ready()
      this.trackers.push({ name, spaceId: space?.spaceId ?? null, bee, owned: name !== PROFILE_BEE, range: bee.core.download({ start: 0, end: -1 }), firstHolderAt: null, released: false })
    }
    this.progress = this.trackers.some((t) => t.name === PROFILE_BEE)
      ? { verdict: RESTORE_VERDICT.NO_HOLDER, length: 0, target: 0, released: false }
      : null
    this.timers.setInterval(() => {
      this.tick().catch((err) => this.log.warn('restore catch-up tick failed:', err.message))
    }, TICK_MS)
  }

  async _close() {
    for (const tracker of this.trackers) await this.untrack(tracker)
  }

  async untrack(tracker) {
    tracker.range?.destroy()
    tracker.range = null
    if (tracker.owned) await tracker.bee.close().catch(() => {})
  }

  // The profile's progress, while this worker is restoring it; null otherwise.
  status() {
    return this.progress ? { ...this.progress } : null
  }

  // Ticks never overlap: a release writes the hold file, and two writing at once could undo one.
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const pending = this.trackers.filter((t) => !t.released)
      if (!pending.length) return
      const spaces = await listSpaces()
      const self = getLocalPublicKeyHex()
      for (const tracker of pending) await this.check(tracker, this.holdersPossible(tracker, spaces, self))
    } finally {
      this.ticking = false
    }
  }

  // A catalog whose space this device no longer knows has nobody who could hold more of it.
  holdersPossible(tracker, spaces, self) {
    if (tracker.name === PROFILE_BEE) return coMembers(spaces, self, null)
    return tracker.spaceId ? coMembers(spaces, self, tracker.spaceId) : 0
  }

  async check(tracker, members) {
    const core = tracker.bee.core
    const holderLengths = core.peers.map((peer) => peer.remoteLength).filter((length) => length > 0)
    // The dwell counts from a holder still connected: one that left takes its answer with it.
    if (!holderLengths.length) tracker.firstHolderAt = null
    else if (tracker.firstHolderAt === null) tracker.firstHolderAt = Date.now()
    const verdict = releaseVerdict({
      localLength: core.length,
      contiguousLength: core.contiguousLength,
      holderLengths,
      firstHolderAt: tracker.firstHolderAt,
      now: Date.now(),
      dwellMs: getRestoreReleaseDwellMs(),
      coMembers: members,
    })
    const isProfile = tracker.name === PROFILE_BEE
    if (isProfile) this.progress = { verdict, length: core.contiguousLength, target: Math.max(core.length, ...holderLengths), released: false }
    if (verdict !== RESTORE_VERDICT.CAUGHT_UP) return
    tracker.released = true
    await releaseHeld(tracker.name)
    await this.untrack(tracker)
    if (isProfile) this.progress = { ...this.progress, released: true }
    else if (tracker.spaceId) await reopenOwnCatalog(tracker.spaceId)
    this.log.info('restored', isProfile ? 'profile' : `catalog of ${tracker.spaceId}`, 'matches its holders at length', core.length)
  }
}
