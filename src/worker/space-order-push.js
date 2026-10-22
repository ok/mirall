// @ts-check
// Every client hears the spaces list again when activity changed what it shows: the order of the
// spaces it already lists, or the time on a card that no longer reads as now. Activity in a space
// already first, within a minute of the last push, changes neither, so a folder syncing file by file
// does not rebuild and resend the whole list every window. A space arriving or leaving reaches the
// clients by its own refresh, so an arrival is taken as held at the time that refresh showed, when it
// was created or joined, without a push.

/** @import { WorkerIpc } from '../shared/core/ipc.js' */
/** @import { Logger } from '../shared/core/logger.js' */
import { getProfile } from '../shared/spaces/profile.js'
import { listSpaces } from '../shared/spaces/space.js'
import { slimSpaces, lastActivity, byLastActivity } from './space-projection.js'

const STALE_AFTER_MS = 60000

async function currentOrder() {
  return (await listSpaces()).filter((s) => !s.leaving)
    .map((s) => ({ spaceId: s.spaceId, name: s.name, created: Date.parse(s.created) || 0, lastActivity: lastActivity(s) }))
    .sort(byLastActivity)
}

/** @param {{ ipc: WorkerIpc, log: Logger }} deps */
export function createSpaceOrderPush({ ipc, log }) {
  // The time each space has on the clients, which also gives the order they show.
  /** @type {Map<string, number>} */
  let shown = new Map()

  /** @param {{ spaceId: string, created: number }[]} rows */
  function adopt(rows) {
    shown = new Map(rows.map((s) => [s.spaceId, shown.get(s.spaceId) ?? s.created]))
  }

  /** @param {{ spaceId: string, name: string, lastActivity: number }[]} rows @param {number} now */
  function changed(rows, now) {
    const held = rows.map((s) => ({ ...s, lastActivity: /** @type {number} */ (shown.get(s.spaceId)) })).sort(byLastActivity)
    if (held.map((s) => s.spaceId).join() !== rows.map((s) => s.spaceId).join()) return true
    return rows.some((s) => {
      const pushed = /** @type {number} */ (shown.get(s.spaceId))
      return s.lastActivity > pushed && now - pushed >= STALE_AFTER_MS
    })
  }

  async function push() {
    const rows = await currentOrder()
    adopt(rows)
    if (!changed(rows, Date.now())) return
    const spaces = await slimSpaces(await getProfile())
    shown = new Map(spaces.map((s) => [s.spaceId, s.lastActivity]))
    ipc.emit('event:state', { spaces })
  }

  return {
    // The order every client is handed when it attaches, taken once the times are loaded.
    baseline: async () => { shown = new Map((await currentOrder()).map((s) => [s.spaceId, s.lastActivity])) },
    announce: () => { push().catch((err) => log.warn('spaces list not pushed:', err.message)) },
  }
}
