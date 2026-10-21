// @ts-check
// Every client hears the spaces list again when activity changed what it shows: the order, or the
// time on a card that no longer reads as now. Activity in a space already first, within a minute of
// the last push, changes neither, so a folder syncing file by file does not rebuild and resend the
// whole list every window.

/** @import { WorkerIpc } from '../shared/core/ipc.js' */
/** @import { Logger } from '../shared/core/logger.js' */
import { getProfile } from '../shared/spaces/profile.js'
import { listSpaces } from '../shared/spaces/space.js'
import { slimSpaces, lastActivity, byLastActivity } from './space-projection.js'

const STALE_AFTER_MS = 60000

/** @param {{ ipc: WorkerIpc, log: Logger }} deps */
export function createSpaceOrderPush({ ipc, log }) {
  /** @type {Map<string, number>} */
  let shown = new Map()
  let shownOrder = ''

  /** @param {number} now */
  async function changed(now) {
    const rows = (await listSpaces()).filter((s) => !s.leaving)
      .map((s) => ({ spaceId: s.spaceId, name: s.name, lastActivity: lastActivity(s) }))
      .sort(byLastActivity)
    if (rows.map((s) => s.spaceId).join() !== shownOrder) return true
    return rows.some((s) => {
      const pushed = shown.get(s.spaceId) ?? 0
      return s.lastActivity > pushed && now - pushed >= STALE_AFTER_MS
    })
  }

  async function push() {
    if (!(await changed(Date.now()))) return
    const spaces = await slimSpaces(await getProfile())
    shown = new Map(spaces.map((s) => [s.spaceId, s.lastActivity]))
    shownOrder = spaces.map((s) => s.spaceId).join()
    ipc.emit('event:state', { spaces })
  }

  return () => { push().catch((err) => log.warn('spaces list not pushed:', err.message)) }
}
