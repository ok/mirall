// Brings a restored profile up to the copies peers hold and lifts its hold once they match
// (restore-hold-rules.js). The writable reopen is left to the next worker: restore mode skipped every
// boot step that writes the profile, and a normal boot runs them in order.
import { Subsystem } from '../shared/core/subsystem.js'
import { releaseHeld, PROFILE_BEE } from '../shared/core/restore-hold.js'
import { releaseVerdict } from '../shared/core/restore-hold-rules.js'
import { RESTORE_VERDICT } from '../shared/contract/restore-verdict.js'
import { getRestoreReleaseDwellMs } from '../shared/core/runtime-config.js'
import { listSpaces } from '../shared/spaces/space.js'
import { getLocalPublicKeyHex } from '../shared/spaces/profile.js'

const TICK_MS = 2000

async function coMemberCount() {
  const self = getLocalPublicKeyHex()
  const keys = new Set()
  for (const space of await listSpaces()) {
    for (const member of space.members || []) if (member.publicKey !== self) keys.add(member.publicKey)
  }
  return keys.size
}

export class RestoreCatchUp extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('profile') }

  async _open() {
    this.firstHolderAt = null
    this.progress = { verdict: RESTORE_VERDICT.NO_HOLDER, length: 0, target: 0, released: false }
    this.range = this.deps.profile.bee.core.download({ start: 0, end: -1 })
    this.timers.setInterval(() => {
      this.tick().catch((err) => this.log.warn('restore catch-up tick failed:', err.message))
    }, TICK_MS)
  }

  async _close() {
    this.range?.destroy()
  }

  status() {
    return { ...this.progress }
  }

  async tick() {
    const core = this.deps.profile.bee?.core
    if (!core || this.progress.released) return
    const holderLengths = core.peers.map((peer) => peer.remoteLength).filter((length) => length > 0)
    // The dwell counts from a holder still connected: one that left takes its answer with it.
    if (!holderLengths.length) this.firstHolderAt = null
    else if (this.firstHolderAt === null) this.firstHolderAt = Date.now()
    const verdict = releaseVerdict({
      localLength: core.length,
      contiguousLength: core.contiguousLength,
      holderLengths,
      firstHolderAt: this.firstHolderAt,
      now: Date.now(),
      dwellMs: getRestoreReleaseDwellMs(),
      coMembers: await coMemberCount(),
    })
    this.progress = { verdict, length: core.contiguousLength, target: Math.max(core.length, ...holderLengths), released: false }
    if (verdict !== RESTORE_VERDICT.CAUGHT_UP) return
    await releaseHeld(PROFILE_BEE)
    this.progress = { ...this.progress, released: true }
    this.log.info('restored profile matches its holders at length', core.length)
  }
}
