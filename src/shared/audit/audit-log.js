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
//   seen/<beeKeyHex>            -> the version of a peer's bee we have already turned into rows.
//                                  Working state, not a record: audit:purge deliberately leaves
//                                  it, because resetting it would replay every peer's whole
//                                  history as if it had just happened.
import { createLocalBee } from '../core/store.js'
import { createLogger } from '../core/logger.js'
import { buildRecord } from './audit-record.js'
import {
  AGE_HYSTERESIS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_RETENTION_DAYS,
  ageCutoff,
  normalizeConfig,
  pruneUpTo,
} from './audit-retention.js'

const log = createLogger('audit')

const SEQ_WIDTH = 16
const EVT = 'evt/'
const BY_SPACE = 'by-space/'
const CONFIG_KEY = 'config'
const SEEN = 'seen/'
const PSTATE = 'pstate/'
const HIGH = '￿'

// Rows walked per query call before returning a partial page. A filtered listing may have to
// walk far past `limit` to fill it; this bounds the work so one query cannot stall the worker.
const SCAN_BUDGET = 5000

const RATE_WINDOW_MS = 60000
const RATE_MAX_PER_WINDOW = 120

const pad = (seq) => String(seq).padStart(SEQ_WIDTH, '0')
const evtKey = (seq) => EVT + pad(seq)
const spaceKey = (spaceId, seq) => BY_SPACE + spaceId + '/' + pad(seq)

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
  bee = createLocalBee('audit-log')
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
export function record(kind, fields = {}) {
  if (!bee || !config.enabled) return
  if (!admit(kind)) return
  writeChain = writeChain
    .then(() => append(kind, fields))
    .catch((err) => log.warn('write failed:', kind, err.message))
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

// Newest-first walk. The space filter rides the by-space index; everything else walks the
// primary range. `cursor` is the highest seq to consider (exclusive upper bound is cursor + 1).
async function* walk(spaceId, cursor) {
  const upper = cursor == null ? null : pad(cursor + 1)
  if (spaceId) {
    const prefix = BY_SPACE + spaceId + '/'
    const range = { gte: prefix, lt: upper == null ? prefix + HIGH : prefix + upper }
    for await (const entry of bee.createReadStream(range, { reverse: true })) {
      const node = await bee.get(EVT + pad(entry.value))
      if (node?.value) yield node.value
    }
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
export async function auditSpaces() {
  if (!bee) return []
  const seen = new Map()
  for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH }, { reverse: true })) {
    const space = entry.value?.space
    if (space?.id && !seen.has(space.id)) seen.set(space.id, space.name || null)
  }
  return [...seen].map(([id, name]) => ({ id, name }))
}

export async function auditActors() {
  if (!bee) return []
  const seen = new Map()
  for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH }, { reverse: true })) {
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
  let count = 0
  for await (const _entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH })) count += 1
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
  await bee.put(PSTATE + key, state)
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
// blocks, so a range clear can drop a node the live index still points at. Growth is bounded in
// the meantime by `maxEntries`, which caps the row count regardless of the age window. Reclaiming
// the bytes needs its own change (measure first; the established pattern elsewhere in the
// codebase is purge-and-recreate the core, not an in-place clear).

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
    for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH })) {
      const rec = entry.value
      if (!rec) continue
      if (rec.ts < cutoff) {
        seqAtOrBelowAge = rec.seq
        aboveAge = 0
        continue
      }
      aboveAge += 1
      if (aboveAge >= AGE_HYSTERESIS) break
    }
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
    await batch.flush()
    removed += 1
  }
  if (removed) log.info('pruned', removed, 'rows up to seq', upTo)
  return { removed }
}

export async function purgeAudit() {
  if (!bee) return { purged: 0 }
  await flushAudit()
  let purged = 0
  for await (const entry of bee.createReadStream({ gte: EVT, lt: EVT + HIGH })) {
    await bee.del(entry.key)
    purged += 1
  }
  for await (const entry of bee.createReadStream({ gte: BY_SPACE, lt: BY_SPACE + HIGH })) {
    await bee.del(entry.key)
  }
  rateBuckets.clear()
  log.info('purged', purged, 'rows')
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
