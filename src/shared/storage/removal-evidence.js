// Removals made through the leave and join flows, recorded at the moment they happen, so a backup can
// tell a space that was left from data that went missing. Only those flows write here: the leftover
// sweep is the one path that deletes data with no such action behind it, and it must stay able to
// raise a loss. Kept in `reclaim-meta` beside the sweep journal; an entry older than KEEP_MS no longer
// counts and is dropped at the next write, which outlasts the loss check's week of acceptance and
// retention's month-long pin.
//
// Entry: { at, kind: 'space-left' | 'join-discarded' | 'join-denied', spaceId, name }
// Key:   removal/<at, 16 digits>-<seq, 4 digits>, chronological
import { createLogger } from '../core/logger.js'
import { journalKey, withReclaimMeta, readJournal } from './reclaim-journal.js'

const log = createLogger('removal-evidence')
const PREFIX = 'removal/'
export const KEEP_MS = 60 * 24 * 60 * 60 * 1000

// Evidence that fails to write only makes a later loss check stricter.
export async function recordRemoval({ kind, spaceId, name = null }, { now = Date.now() } = {}) {
  await withReclaimMeta(async (bee) => {
    await bee.put(journalKey(PREFIX, now), { at: now, kind, spaceId, name })
    for (const node of await readJournal(bee, PREFIX)) {
      if (now - node.value.at <= KEEP_MS) break
      await bee.del(node.key)
    }
  }, { log, failure: 'could not record the removal:', fallback: undefined })
}

// Each space removed within KEEP_MS, with the time of its latest removal. An unreadable record
// explains nothing, so the loss check stays strict.
export async function removedSpaces({ now = Date.now() } = {}) {
  const nodes = await withReclaimMeta((bee) => readJournal(bee, PREFIX), { log, failure: 'could not read the removal record:', fallback: [] })
  const spaces = new Map()
  for (const { value } of nodes) {
    if (typeof value.spaceId === 'string' && now - value.at <= KEEP_MS) spaces.set(value.spaceId, value.at)
  }
  return spaces
}

export async function listRecentRemovals(limit = 20) {
  return withReclaimMeta(async (bee) => (await readJournal(bee, PREFIX, { reverse: true, limit })).map((node) => node.value), {
    log, failure: 'could not read the removal record:', fallback: [],
  })
}
