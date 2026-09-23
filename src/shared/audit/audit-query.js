// Reads over the audit bee: the paginated newest-first listing, the filter vocabularies, the
// stats and the JSON export. Every walk but the export is bounded by SCAN_BUDGET — an unbounded
// scan of a 200k-row encrypted bee stalls the single worker loop that also runs transfers.
import { auditBee, flushAudit, newestSeq, oldestSeq } from './audit-log.js'
import { AGE_HYSTERESIS } from './audit-retention.js'
import { BY_DEVICE, BY_SPACE, evtKey, evtRange, indexRange } from './audit-keys.js'
import { SCHEMA_VERSION } from './audit-record.js'
/** @import { AuditEntry, AuditPage } from '../contract/responses.js' */

// Rows walked per query call before returning a partial page. A filtered listing may have to
// walk far past `limit` to fill it; this bounds the work so one query cannot stall the worker.
const SCAN_BUDGET = 5000

const PAGE_LIMIT = 50

const EMPTY_STATS = { count: 0, oldestTs: null, newestTs: null, oldestSeq: null, newestSeq: null }

function buildFilters({ kinds, categories, actorKey, search, since, until }) {
  return {
    kindSet: kinds?.length ? new Set(kinds) : null,
    catSet: categories?.length ? new Set(categories) : null,
    actorKey: actorKey || null,
    needle: search ? String(search).trim().toLowerCase() : null,
    since,
    until,
  }
}

// `since` is not checked here: the page walk applies it with hysteresis before matching.
function matches(rec, { kindSet, catSet, actorKey, needle, until }) {
  if (until != null && rec.ts > until) return false
  if (kindSet && !kindSet.has(rec.kind)) return false
  // `category` is stamped at write time, so filtering never re-derives it from `kind` — a kind
  // retired in a later version must still filter correctly from an already-stored row.
  if (catSet && !catSet.has(rec.category)) return false
  if (actorKey && rec.actor?.key !== actorKey) return false
  if (needle && !(rec.search || '').includes(needle)) return false
  return true
}

async function* fromIndex(bee, prefix, below) {
  for await (const entry of bee.createReadStream(indexRange(prefix, below), { reverse: true })) {
    const node = await bee.get(evtKey(entry.value))
    if (node?.value) yield node.value
  }
}

async function* mergeDesc(a, b) {
  try {
    let ta = await a.next()
    let tb = await b.next()
    while (!ta.done || !tb.done) {
      if (tb.done || (!ta.done && ta.value.seq > tb.value.seq)) {
        yield ta.value
        ta = await a.next()
      } else {
        yield tb.value
        tb = await b.next()
      }
    }
  } finally {
    // `yield*` forwards return() to this generator, but a and b are pulled by hand, so they would
    // stay suspended with their read streams undestroyed. queryAudit breaks out on every full page,
    // which is the normal path — without this, each one leaks two streams.
    await a.return?.()
    await b.return?.()
  }
}

// Newest-first walk. The space filter rides the by-space index MERGED with the device index —
// a connectivity outage is why nothing arrived, so it belongs in the space's story even though it
// is not attributable to the space. Merging two ordered streams keeps the index property; the
// alternative under a space filter is a full primary-range scan, which is what the index exists to
// avoid. `cursor` is the highest seq to consider.
async function* walk(bee, spaceId, cursor) {
  const below = cursor == null ? null : cursor + 1
  if (spaceId) {
    yield* mergeDesc(fromIndex(bee, BY_SPACE + spaceId + '/', below), fromIndex(bee, BY_DEVICE, below))
    return
  }
  for await (const entry of bee.createReadStream(evtRange(below), { reverse: true })) {
    if (entry.value) yield entry.value
  }
}

// Age hysteresis: one row under the cutoff is not proof the rest are, because a backwards clock
// jump breaks the seq/ts correspondence. The walk only stops after AGE_HYSTERESIS consecutive.
async function collectPage(rows, filters, limit) {
  const entries = []
  let walked = 0
  let belowAge = 0
  let lastSeq = null
  let exhausted = true
  for await (const rec of rows) {
    walked += 1
    lastSeq = rec.seq
    if (filters.since != null && rec.ts < filters.since) {
      belowAge += 1
      if (belowAge >= AGE_HYSTERESIS) break
      continue
    }
    belowAge = 0
    if (matches(rec, filters)) entries.push(rec)
    if (entries.length >= limit || walked >= SCAN_BUDGET) {
      exhausted = rec.seq <= 0
      break
    }
  }
  const more = !exhausted && lastSeq != null && lastSeq > 0
  return { entries, nextCursor: more ? lastSeq - 1 : null }
}

// Returns { entries, nextCursor }. `entries` may be SHORTER than `limit` while nextCursor is
// non-null: a partial page is normal under a filter, and the viewer renders "Load more" rather
// than a total (a filtered total would need a full scan).
/**
 * @param {{ spaceId?: string | null, cursor?: number | null, limit?: number | null, kinds?: readonly string[] | null,
 *   categories?: readonly string[] | null, actorKey?: string | null, search?: string | null, since?: number | null,
 *   until?: number | null }} [query]
 * @returns {Promise<AuditPage>}
 */
export async function queryAudit({ spaceId = null, cursor = null, limit = null, ...filterOpts } = {}) {
  const bee = auditBee()
  if (!bee) return { entries: [], nextCursor: null }
  return collectPage(walk(bee, spaceId, cursor), buildFilters(filterOpts), limit ?? PAGE_LIMIT)
}

// The most recent SCAN_BUDGET rows, reduced to the distinct refs `pick` names. These fill the
// filter dropdowns, so bounded means they describe recent activity, which is what a filter is for.
async function distinctRecent(bee, pick) {
  const seen = new Map()
  let walked = 0
  for await (const entry of bee.createReadStream(evtRange(), { reverse: true })) {
    if (walked++ >= SCAN_BUDGET) break
    const ref = pick(entry.value)
    if (ref?.id && !seen.has(ref.id)) seen.set(ref.id, ref.name || null)
  }
  return seen
}

// The spaces the LOG knows about — not the spaces the user is currently in. Rows survive a
// space leave (which deletes the spaces-meta record), and they must stay filterable, so the
// viewer's space filter reads this rather than spaces:list.
export async function auditSpaces() {
  const bee = auditBee()
  if (!bee) return []
  const spaces = await distinctRecent(bee, (rec) => rec?.space)
  return [...spaces].map(([id, name]) => ({ id, name }))
}

export async function auditActors() {
  const bee = auditBee()
  if (!bee) return []
  const actors = await distinctRecent(bee, (rec) => rec?.actor && { id: rec.actor.key, name: rec.actor.name })
  return [...actors].map(([key, name]) => ({ key, name }))
}

export async function auditStats() {
  const bee = auditBee()
  if (!bee) return { ...EMPTY_STATS }
  const oldest = await oldestSeq()
  const newest = await newestSeq()
  if (oldest < 0) return { ...EMPTY_STATS }
  const first = await bee.get(evtKey(oldest))
  const last = await bee.get(evtKey(newest))
  // seqs are dense: appends increment nextSeq and pruning only ever deletes a contiguous
  // prefix, so the row count is derivable without walking the whole range.
  return {
    count: newest - oldest + 1,
    oldestTs: first?.value?.ts ?? null,
    newestTs: last?.value?.ts ?? null,
    oldestSeq: oldest,
    newestSeq: newest,
  }
}

// Rows written before the install id got its own name spell it `device`. The export declares one
// schema version for the whole file, so it must hand back one spelling: normalize on the way out
// rather than leave a consumer to guess which rows predate the rename.
function atExportVersion(rec) {
  if (rec.v >= SCHEMA_VERSION) return rec
  const { device, ...rest } = rec
  return { ...rest, v: SCHEMA_VERSION, installId: device ?? null }
}

// Whole-log JSON export. Streams the primary range in ascending order so the file reads
// chronologically.
/**
 * @param {{ spaceId?: string | null, since?: number | null, until?: number | null }} [range]
 * @returns {Promise<AuditEntry[]>}
 */
export async function exportAudit({ spaceId = null, since = null, until = null } = {}) {
  const bee = auditBee()
  if (!bee) return []
  await flushAudit()
  const out = []
  for await (const entry of bee.createReadStream(evtRange())) {
    const rec = entry.value
    if (!rec) continue
    if (spaceId && rec.space?.id !== spaceId) continue
    if (since != null && rec.ts < since) continue
    if (until != null && rec.ts > until) continue
    out.push(atExportVersion(rec))
  }
  return out
}
