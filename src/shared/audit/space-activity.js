// When this device last saw activity in each space, which orders the spaces list. Fed from the
// audit call sites before the log's recording switch and rate budget, and from folder-share changes
// that write no rows, so it is not a history the user can switch off and it never reads the log
// except to seed itself once. The time is when this device saw the act, never the author's clock.
// Local-only: the `space-activity` bee is never replicated and never reported anywhere.
// Imports core/, contract/ and its audit/ siblings only, like audit-log.js, whose record() calls in
// here.
import { createLocalBee } from '../core/store.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { prefixRange } from '../core/bee-keys.js'
import { makeKeyedCoalescer } from '../core/coalesce.js'
import { ownedScheduler } from '../core/timers.js'
import { SPACE_ACTIVITY_KINDS } from '../contract/audit-kinds.js'
import { BY_SPACE, evtKey, indexRange } from './audit-keys.js'

const log = createLogger('space-activity')

const SPACE = 'space/'
const SEEDED_KEY = 'seeded'
const PERSIST_DELAY_MS = 30000
// A folder being synced stamps once per file; the list re-sorts at most this often.
const ANNOUNCE_INTERVAL_MS = 2000
// A space's newest counting row is almost always among its newest rows; past this a space seeds
// from its creation time like one with no rows.
const SEED_SCAN_LIMIT = 500

const counting = new Set(SPACE_ACTIVITY_KINDS)

// Stamps land here first, so an act seen before the bee opens or between its writes still counts.
const lastSeen = new Map()
const dirty = new Set()
let bee = null
let onChange = null

// The live bee, for tests that need to rewind it. Not for production callers.
/** @internal */
export function _spaceActivityBeeForTests() {
  return bee
}

export function lastActivityOf(spaceId) {
  return lastSeen.get(spaceId) ?? null
}

export function noteSpaceActivity(spaceId) {
  if (typeof spaceId !== 'string' || !spaceId) return
  lastSeen.set(spaceId, Date.now())
  dirty.add(spaceId)
  onChange?.()
}

export function isSpaceActivityKind(kind) {
  return counting.has(kind)
}

export function noteActivityKind(kind, spaceId) {
  if (counting.has(kind)) noteSpaceActivity(spaceId)
}

export async function forgetSpaceActivity(spaceId) {
  lastSeen.delete(spaceId)
  dirty.delete(spaceId)
  await bee?.del(SPACE + spaceId)
}

// Takes the dirty set before the first await, so a stamp landing mid-write stays dirty for the next
// one, and gives it back when the write fails.
async function persist() {
  if (!bee || dirty.size === 0) return
  const ids = [...dirty]
  dirty.clear()
  try {
    const batch = bee.batch()
    for (const spaceId of ids) {
      const ms = lastSeen.get(spaceId)
      if (ms != null) await batch.put(SPACE + spaceId, ms)
    }
    await batch.flush()
  } catch (err) {
    for (const spaceId of ids) if (lastSeen.has(spaceId)) dirty.add(spaceId)
    throw err
  }
}

// Loads the stored times and drops those of spaces that are gone: a stamp can land just after its
// space was forgotten, and nothing else would ever delete it.
async function load(liveIds) {
  const gone = []
  for await (const entry of bee.createReadStream(prefixRange(SPACE))) {
    const spaceId = entry.key.slice(SPACE.length)
    if (!liveIds.has(spaceId)) gone.push(entry.key)
    else if (!lastSeen.has(spaceId)) lastSeen.set(spaceId, entry.value)
  }
  for (const key of gone) await bee.del(key)
}

// A space's newest counting row in the audit log, newest first through its by-space index.
async function newestCountingRow(auditBee, spaceId) {
  let scanned = 0
  for await (const entry of auditBee.createReadStream(indexRange(BY_SPACE + spaceId + '/'), { reverse: true })) {
    if (++scanned > SEED_SCAN_LIMIT) return null
    const rec = (await auditBee.get(evtKey(entry.value)))?.value
    if (rec && counting.has(rec.kind)) return rec.ts
  }
  return null
}

// Runs once per install, so the spaces of someone updating do not start out tied. A log that is not
// open leaves the mark unwritten and the next boot tries again.
async function seedOnce(auditBee, spaceIds) {
  if ((await bee.get(SEEDED_KEY))?.value) return
  if (!auditBee) return
  for (const spaceId of spaceIds) {
    if (lastSeen.has(spaceId)) continue
    const ts = await newestCountingRow(auditBee, spaceId)
    if (ts == null) continue
    lastSeen.set(spaceId, ts)
    dirty.add(spaceId)
  }
  await persist()
  await bee.put(SEEDED_KEY, true)
}

// deps: auditBee() — the open audit log or null; spaceIds() — the spaces to seed;
// onChange() — the order may have changed; called at most once per ANNOUNCE_INTERVAL_MS.
export class SpaceActivity extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('auditBee', 'spaceIds', 'onChange')
    this.persistTimer = null
  }

  // A bee that fails to open is closed again, so the times live in memory for this run.
  async _open() {
    const opening = createLocalBee('space-activity')
    try {
      await opening.ready()
      bee = opening
      const spaceIds = await this.deps.spaceIds()
      await load(new Set(spaceIds))
      try {
        await seedOnce(this.deps.auditBee(), spaceIds)
      } catch (err) {
        log.warn('seed from the activity log deferred:', err.message)
      }
    } catch (err) {
      bee = null
      await opening.close().catch(() => {})
      throw err
    }
    const announce = makeKeyedCoalescer(() => this.deps.onChange(), {
      intervalMs: ANNOUNCE_INTERVAL_MS,
      keyOf: () => 'order',
      ...ownedScheduler(() => this.timers),
    })
    onChange = () => {
      announce.poke()
      this.schedulePersist()
    }
    this.schedulePersist()
  }

  // One write per window, however many stamps land in it; the close writes whatever is left.
  schedulePersist() {
    if (this.persistTimer || this.timers.closed || dirty.size === 0) return
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = null
      persist().catch((err) => log.warn('activity times not saved:', err.message))
    }, PERSIST_DELAY_MS)
  }

  async _close() {
    onChange = null
    const closing = bee
    try {
      await persist()
    } catch (err) {
      log.warn('activity times not saved:', err.message)
    }
    bee = null
    lastSeen.clear()
    dirty.clear()
    await closing?.close()
  }
}
