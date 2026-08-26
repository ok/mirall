// The on-device audit log: a local-only Hyperbee, registered in LOCAL_BEE_NAMES so it inherits
// the M-derived at-rest encryption. It is never replicated, never announced, and never leaves
// the device.
//
// This module imports only from core/. The instrumentation call sites live across spaces/,
// transfer/ and folders/, so any import back into those would close a dependency cycle.
//
// Key layout (both pure appends — no read-modify-write on the hot path):
//   evt/<seq padded>            -> the record. Zero-padded so lexicographic order is numeric
//                                  order, which makes a reverse range scan both the
//                                  newest-first listing and the pagination cursor.
//   by-space/<spaceId>/<seq>    -> seq. Serves the space filter without a full scan.
//   by-device/<seq>             -> seq. The same index for the rows that have NO space (device
//                                  connectivity). An outage is why the file never arrived, so it
//                                  belongs in a space's timeline — but attributing it TO the space
//                                  would be wrong, hence a second index rather than a fan-out.
//   seen/<beeKeyHex>            -> the version of a peer's bee we have already turned into rows.
//                                  Working state, not a record: audit:purge deliberately leaves
//                                  it, because resetting it would replay every peer's whole
//                                  history as if it had just happened.
import { createLocalBee, getStore } from '../core/store.js'
import { createLogger } from '../core/logger.js'
import { buildRecord } from './audit-record.js'
import { STATE_OFF } from './peer-observer.js'
import {
  AGE_HYSTERESIS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_RETENTION_DAYS,
  ageCutoff,
  normalizeConfig,
  pruneUpTo,
} from './audit-retention.js'

const log = createLogger('audit')

const AUDIT_BEE_NAME = 'audit-log'
const SEQ_WIDTH = 16
const EVT = 'evt/'
const BY_SPACE = 'by-space/'
const BY_DEVICE = 'by-device/'
const CONFIG_KEY = 'config'
const SEEN = 'seen/'
const PSTATE = 'pstate/'
const NSTATE = 'nstate'
const HIGH = '￿'

// Rows walked per query call before returning a partial page. A filtered listing may have to
// walk far past `limit` to fill it; this bounds the work so one query cannot stall the worker.
const SCAN_BUDGET = 5000

const RATE_WINDOW_MS = 60000
const RATE_MAX_PER_WINDOW = 120

const pad = (seq) => String(seq).padStart(SEQ_WIDTH, '0')
const evtKey = (seq) => EVT + pad(seq)
const spaceKey = (spaceId, seq) => BY_SPACE + spaceId + '/' + pad(seq)
const deviceKey = (seq) => BY_DEVICE + pad(seq)

let bee = null
let nextSeq = 0
let device = null
let selfIdentity = { key: null, name: null }
let config = {
  enabled: true,
  retentionDays: DEFAULT_RETENTION_DAYS,
  maxEntries: DEFAULT_MAX_ENTRIES,
}

// Appends are serialized through one chain so two concurrent record() calls can never claim the
// same seq — the durable ordering the whole cursor scheme rests on.
let writeChain = Promise.resolve()

const rateBuckets = new Map()

export async function initAuditLog({ installId = null } = {}) {
  bee = createLocalBee(AUDIT_BEE_NAME)
  await bee.ready()
  device = installId
  const stored = await bee.get(CONFIG_KEY)
  if (stored?.value) config = normalizeConfig(stored.value, config)
  nextSeq = (await newestSeq()) + 1
  log.info('ready — next seq', nextSeq, 'retention', config.retentionDays + 'd', 'enabled', config.enabled)
}

// The local identity, filled into any actor a call site declares as 'self'. Held here rather
// than threaded through every call site: modules deep in transfer/ have no access to the profile,
// and a self row that renders without a name shows a bare '?' avatar.
export function setAuditIdentity({ key = null, name = null } = {}) {
  selfIdentity = { key: key ?? selfIdentity.key, name: name ?? selfIdentity.name }
}

export function isAuditReady() {
  return bee !== null
}

export async function closeAuditLog() {
  const pending = writeChain
  bee = null
  await pending.catch(() => {})
}

async function newestSeq() {
  for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH }, { reverse: true, limit: 1 })) {
    return Number(entry.key.slice(EVT.length))
  }
  return -1
}

async function oldestSeq() {
  for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH }, { limit: 1 })) {
    return Number(entry.key.slice(EVT.length))
  }
  return -1
}

// A per-kind token bucket. On overflow it collapses into ONE audit.suppressed row per window
// rather than dropping silently: a gap the reader cannot see is worse than a visible one.
function admit(kind) {
  if (kind === 'audit.suppressed') return true
  const now = Date.now()
  let bucket = rateBuckets.get(kind)
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    const suppressed = bucket?.suppressed || 0
    bucket = { count: 0, windowStart: now, suppressed: 0 }
    rateBuckets.set(kind, bucket)
    if (suppressed > 0) {
      record('audit.suppressed', { subject: { kind, count: suppressed, windowMs: RATE_WINDOW_MS } })
    }
  }
  if (bucket.count >= RATE_MAX_PER_WINDOW) {
    bucket.suppressed += 1
    return false
  }
  bucket.count += 1
  return true
}

// Fire-and-forget from every call site: auditing must never fail, slow, or throw into the
// operation it describes. Failures are logged and swallowed.
// Returns whether the row was ADMITTED (log open, enabled, within the rate budget). The
// write itself stays fire-and-forget, but callers that mirror "we recorded this" into
// durable state need to know when nothing was recorded at all.
export function record(kind, fields = {}) {
  if (!bee || !config.enabled) return false
  if (!admit(kind)) return false
  writeChain = writeChain
    .then(() => append(kind, fields))
    .catch((err) => log.warn('write failed:', kind, err.message))
  return true
}

function withSelfIdentity(actor) {
  if (!actor || actor.type !== 'self') return actor
  return { type: 'self', key: actor.key ?? selfIdentity.key, name: actor.name ?? selfIdentity.name }
}

async function append(kind, fields) {
  if (!bee) return
  const now = Date.now()
  const seq = nextSeq++
  const rec = buildRecord({
    ...fields,
    actor: withSelfIdentity(fields.actor),
    kind,
    seq,
    ts: now,
    tzOffset: -new Date(now).getTimezoneOffset(),
    device,
  })
  const batch = bee.batch()
  await batch.put(evtKey(seq), rec)
  if (rec.space?.id) await batch.put(spaceKey(rec.space.id, seq), seq)
  else await batch.put(deviceKey(seq), seq)
  await batch.flush()
}

// Awaits everything queued so far. Tests and the export path need the log settled; production
// call sites never do.
export async function flushAudit() {
  await writeChain.catch(() => {})
}

function matches(rec, { kindSet, catSet, actorKey, needle, since, until }) {
  if (since != null && rec.ts < since) return false
  if (until != null && rec.ts > until) return false
  if (kindSet && !kindSet.has(rec.kind)) return false
  // `category` is stamped at write time, so filtering never re-derives it from `kind` — a kind
  // retired in a later version must still filter correctly from an already-stored row.
  if (catSet && !catSet.has(rec.category)) return false
  if (actorKey && rec.actor?.key !== actorKey) return false
  if (needle && !(rec.search || '').includes(needle)) return false
  return true
}

async function* fromIndex(prefix, upper) {
  const range = { gte: prefix, lt: upper == null ? prefix + HIGH : prefix + upper }
  for await (const entry of bee.createReadStream(range, { reverse: true })) {
    const node = await bee.get(EVT + pad(entry.value))
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
// avoid. `cursor` is the highest seq to consider (exclusive upper bound is cursor + 1).
async function* walk(spaceId, cursor) {
  const upper = cursor == null ? null : pad(cursor + 1)
  if (spaceId) {
    yield* mergeDesc(fromIndex(BY_SPACE + spaceId + '/', upper), fromIndex(BY_DEVICE, upper))
    return
  }
  const range = { gte: EVT, lt: upper == null ? EVT + HIGH : EVT + upper }
  for await (const entry of bee.createReadStream(range, { reverse: true })) {
    if (entry.value) yield entry.value
  }
}

// Returns { entries, nextCursor }. `entries` may be SHORTER than `limit` while nextCursor is
// non-null: a partial page is normal under a filter, and the viewer renders "Load more" rather
// than a total (a filtered total would need a full scan).
export async function queryAudit({
  spaceId = null,
  kinds = null,
  categories = null,
  actorKey = null,
  search = null,
  since = null,
  until = null,
  cursor = null,
  limit = 50,
} = {}) {
  if (!bee) return { entries: [], nextCursor: null }
  const filters = {
    kindSet: kinds?.length ? new Set(kinds) : null,
    catSet: categories?.length ? new Set(categories) : null,
    actorKey: actorKey || null,
    needle: search ? String(search).trim().toLowerCase() : null,
    since,
    until,
  }

  const entries = []
  let walked = 0
  let belowAge = 0
  let lastSeq = null
  let exhausted = true

  for await (const rec of walk(spaceId, cursor)) {
    walked += 1
    lastSeq = rec.seq

    // Age hysteresis: one row under the cutoff is not proof the rest are, because a backwards
    // clock jump breaks the seq/ts correspondence. Require AGE_HYSTERESIS consecutive.
    if (since != null && rec.ts < since) {
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

// The spaces the LOG knows about — not the spaces the user is currently in. Rows survive a
// space leave (which deletes the spaces-meta record), and they must stay filterable, so the
// viewer's space filter reads this rather than spaces:list.
// Both walk newest-first under the same SCAN_BUDGET as queryAudit. These fill the filter
// dropdowns, and the Activity Log fires both on every open — an unbounded scan of a
// 200k-row encrypted bee stalls the single worker loop that also runs transfers. Bounded
// means the lists describe recent activity, which is what a filter is for.
export async function auditSpaces() {
  if (!bee) return []
  const seen = new Map()
  let walked = 0
  for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH }, { reverse: true })) {
    if (walked++ >= SCAN_BUDGET) break
    const space = entry.value?.space
    if (space?.id && !seen.has(space.id)) seen.set(space.id, space.name || null)
  }
  return [...seen].map(([id, name]) => ({ id, name }))
}

export async function auditActors() {
  if (!bee) return []
  const seen = new Map()
  let walked = 0
  for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH }, { reverse: true })) {
    if (walked++ >= SCAN_BUDGET) break
    const actor = entry.value?.actor
    if (actor?.key && !seen.has(actor.key)) seen.set(actor.key, actor.name || null)
  }
  return [...seen].map(([key, name]) => ({ key, name }))
}

export async function auditStats() {
  if (!bee) return { count: 0, oldestTs: null, newestTs: null, oldestSeq: null, newestSeq: null }
  const oldest = await oldestSeq()
  const newest = await newestSeq()
  if (oldest < 0) return { count: 0, oldestTs: null, newestTs: null, oldestSeq: null, newestSeq: null }
  const first = await bee.get(evtKey(oldest))
  const last = await bee.get(evtKey(newest))
  // seqs are dense: appends increment nextSeq and pruning only ever deletes a contiguous
  // prefix, so the row count is derivable without walking the whole range.
  const count = newest - oldest + 1
  return {
    count,
    oldestTs: first?.value?.ts ?? null,
    newestTs: last?.value?.ts ?? null,
    oldestSeq: oldest,
    newestSeq: newest,
  }
}

// The peer-bee watermark. Absent means "never observed" — the caller must adopt the current
// version as a baseline and emit nothing, or first contact would flood the log with history.
export async function getSeenVersion(beeId) {
  if (!bee) return null
  const node = await bee.get(SEEN + beeId)
  return Number.isInteger(node?.value) ? node.value : null
}

export async function setSeenVersion(beeId, version) {
  if (!bee || !Number.isInteger(version)) return
  await bee.put(SEEN + beeId, version)
}

// The last state we RECORDED for one peer subject ('on'/'off'). Durable for the same reason the
// watermark is: a restart must not re-emit an act whose record simply got re-written.
export async function getPeerSubjectState(key) {
  if (!bee) return null
  const node = await bee.get(PSTATE + key)
  return typeof node?.value === 'string' ? node.value : null
}

export async function setPeerSubjectState(key, state) {
  if (!bee) return
  // 'off' is the absence of a subject, so drop the key instead of storing a tombstone that
  // lives forever. Otherwise every path a peer ever shared leaves a permanent row — a peer
  // that shares and unshares 50k loose files would keep 50k keys for good.
  if (state === STATE_OFF) await bee.del(PSTATE + key)
  else await bee.put(PSTATE + key, state)
}

// The last DEVICE connectivity state we RECORDED. Durable for the same reason pstate/ is: without
// it, relaunching on the same bad network writes the same row on every launch, and an in-memory
// guard cannot survive the restart that causes it.
export async function getNetworkState() {
  if (!bee) return null
  const node = await bee.get(NSTATE)
  return node?.value && typeof node.value === 'object' ? node.value : null
}

export async function setNetworkState(state) {
  if (!bee) return
  // Healthy is the absence of an episode, so drop the key rather than store a tombstone.
  if (!state) await bee.del(NSTATE)
  else await bee.put(NSTATE, state)
}

export function getAuditConfig() {
  return { ...config }
}

export async function setAuditConfig(patch = {}) {
  config = normalizeConfig(patch, config)
  if (bee) await bee.put(CONFIG_KEY, config)
  return { ...config }
}

// NOTE — byte-level reclamation is deliberately NOT done here. A Hyperbee `del` only appends a
// tombstone, so pruned rows stop being readable but their blocks stay on disk. Releasing them
// with core.clear() is unsafe as written: Hyperbee interleaves B-tree index nodes with value
// blocks, so a range clear can drop a node the live index still points at — measured, clearing a
// pruned prefix leaves a fresh open reading back zero rows and stalling on a missing block.
// Growth is bounded in the meantime by `maxEntries`, which caps the row count regardless of the
// age window; the residue is ~1KB per pruned row after compaction.
//
// A TOTAL wipe can reclaim, because it need not preserve any index — see purgeAudit, which
// truncates the core to zero instead. That does not generalize to a partial prune: keeping the
// newest N rows would mean copy-forward (read the survivors, truncate, re-append), whose cost
// scales with `maxEntries` on every prune. Worth building only if the residue is shown to matter.

export async function pruneAudit({ now = Date.now() } = {}) {
  if (!bee) return { removed: 0 }
  await flushAudit()
  const newest = await newestSeq()
  if (newest < 0) return { removed: 0 }

  const cutoff = ageCutoff(now, config.retentionDays)
  let seqAtOrBelowAge = null
  if (cutoff != null) {
    // Forward walk from the oldest row: the first run of rows younger than the cutoff ends the
    // scan, using the same hysteresis as the query so a clock jump cannot over-prune.
    let aboveAge = 0
    let firstYoungSeq = null
    for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH })) {
      const rec = entry.value
      if (!rec) continue
      if (rec.ts < cutoff) {
        seqAtOrBelowAge = rec.seq
        aboveAge = 0
        continue
      }
      if (firstYoungSeq === null) firstYoungSeq = rec.seq
      aboveAge += 1
      if (aboveAge >= AGE_HYSTERESIS) break
    }
    // Deletion is inclusive of the watermark, so it must never reach a row inside the
    // retention window. A clock step-back can put a stale ts AFTER fresh rows, which
    // would otherwise drag the watermark past them — the hysteresis above only ends the
    // scan, it does not stop the watermark advancing. Cap at the first young row.
    if (firstYoungSeq !== null && seqAtOrBelowAge !== null && seqAtOrBelowAge >= firstYoungSeq) {
      seqAtOrBelowAge = firstYoungSeq - 1
    }
    if (seqAtOrBelowAge !== null && seqAtOrBelowAge < 0) seqAtOrBelowAge = null
  }

  const upTo = pruneUpTo({
    retentionDays: config.retentionDays,
    maxEntries: config.maxEntries,
    newestSeq: newest,
    seqAtOrBelowAge,
  })
  if (upTo == null || upTo < 0) return { removed: 0 }

  let removed = 0
  for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + pad(upTo + 1) })) {
    const rec = entry.value
    const batch = bee.batch()
    await batch.del(entry.key)
    if (rec?.space?.id) await batch.del(spaceKey(rec.space.id, rec.seq))
    else if (rec) await batch.del(deviceKey(rec.seq))
    await batch.flush()
    removed += 1
  }
  if (removed) log.info('pruned', removed, 'rows up to seq', upTo)
  return { removed }
}

// The user's explicit wipe — and the ONE place bytes are actually reclaimed. Deleting the rows
// key-by-key would free nothing (see the NOTE above pruneAudit): a `del` is an append, so a
// row-wise purge left every original block on disk and added a tombstone per row on top, ending
// with a bigger store than before. A purge discards the whole event set, so it can do what a
// partial prune cannot — reset the core itself.
//
// `truncate(0)` (not a core purge-and-recreate) is the primitive: it empties the tree in place AND
// drops the blocks, so the bee handle stays valid and corestore never has to resolve a same-key
// core it still has cached — recreating the core instead reopens a stale in-memory tracker entry
// whose storage is gone, and every later read hangs. No `clear()` follows it: hypercore's clear
// early-returns once `start >= length`, so after a truncate to zero it is a measured no-op.
//
// Two keys are written back rather than being lost with the reset:
//   config  — retention settings are user preferences, not log content.
//   seen/   — the peer-bee watermarks. Dropping them makes first contact re-read every peer's
//             whole history and replay it as if it had just happened (see the header), turning
//             "delete my activity" into "flood it with a decade of theirs".
// `pstate/` and `nstate` are deliberately NOT written back: both mirror observed state, so they are
// log content, and keeping them would suppress the next standing-state row. The cost is one row
// after a purge if the network is still degraded, which is right — the log was emptied, and the
// standing fact is worth restating.
export async function purgeAudit() {
  if (!bee) return { purged: 0 }
  await flushAudit()

  let purged = 0
  for await (const _entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH })) purged += 1
  const seen = []
  for await (const entry of bee.createReadStream({ gte: SEEN, lt: SEEN + HIGH })) {
    seen.push([entry.key, entry.value])
  }
  const keptConfig = { ...config }

  // A row recorded during those scans is racing a total wipe, so losing it is the right outcome —
  // but the append chain must be idle before the core is reset under it.
  await flushAudit()

  const live = bee
  const core = bee.core
  bee = null // record() no-ops for the reset window rather than appending into a truncating core
  try {
    await core.truncate(0)
  } finally {
    bee = live // same handle, now an empty tree
  }

  nextSeq = 0
  await bee.put(CONFIG_KEY, keptConfig)
  for (const [key, value] of seen) await bee.put(key, value)
  rateBuckets.clear()

  // The truncate releases the blocks; compaction is what returns the bytes to the filesystem
  // (without it the store still reads ~1.5MB of SST churn for a log this size). It is a
  // whole-store pass, affordable here only because a purge is a deliberate, confirmed, one-off
  // user action — never do this on the recurring prune path.
  try {
    await getStore().storage.db.compactRange(null, null, {
      blobGarbageCollectionPolicy: 1,
      blobGarbageCollectionAgeCutoff: 1.0,
    })
  } catch (err) { log.warn('compaction after purge failed:', err.message) }

  log.info('purged', purged, 'rows and reclaimed the core')
  return { purged }
}

// Whole-log JSON export. Streams the primary range in ascending order so the file reads
// chronologically.
export async function exportAudit({ spaceId = null, since = null, until = null } = {}) {
  if (!bee) return []
  await flushAudit()
  const out = []
  for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH })) {
    const rec = entry.value
    if (!rec) continue
    if (spaceId && rec.space?.id !== spaceId) continue
    if (since != null && rec.ts < since) continue
    if (until != null && rec.ts > until) continue
    out.push(rec)
  }
  return out
}
