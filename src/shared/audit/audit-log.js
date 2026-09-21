// The on-device audit log: a local-only Hyperbee, registered in LOCAL_BEE_NAMES so it inherits
// the M-derived at-rest encryption. It is never replicated, never announced, and never leaves
// the device. This module owns the handle and the write path; audit-query.js, audit-reclaim.js
// and audit-watch-state.js reach the handle through auditBee(). Key layout: audit-keys.js.
// Imports core/ and its audit/ siblings only: the instrumentation call sites live across spaces/,
// transfer/ and folders/, so an import back into those closes a cycle.
import { createLocalBee } from '../core/store.js'
import { createLogger, fields } from '../core/logger.js'
import { buildRecord, selfActor } from './audit-record.js'
import { DEFAULT_MAX_ENTRIES, DEFAULT_RETENTION_DAYS, normalizeConfig } from './audit-retention.js'
import { createRateGuard } from './audit-rate-guard.js'
import { CONFIG_KEY, evtKey, evtRange, indexKeyOf, seqOf } from './audit-keys.js'
import { ACTOR_TYPE } from '../contract/audit-kinds.js'

const log = createLogger('audit')

const AUDIT_BEE_NAME = 'audit-log'
const SUPPRESSED_KIND = 'audit.suppressed'
const RATE_WINDOW_MS = 60000
const RATE_MAX_PER_WINDOW = 120
const FAILURE_WARN_WINDOW_MS = 600000

let bee = null
let nextSeq = 0
let installId = null
let selfIdentity = { key: null, name: null }
let config = {
  enabled: true,
  retentionDays: DEFAULT_RETENTION_DAYS,
  maxEntries: DEFAULT_MAX_ENTRIES,
}

// Appends are serialized through one chain so two concurrent record() calls can never claim the
// same seq — the durable ordering the whole cursor scheme rests on.
let writeChain = Promise.resolve()

const rateGuard = createRateGuard({
  windowMs: RATE_WINDOW_MS,
  max: RATE_MAX_PER_WINDOW,
  onSuppressed: (kind, count) => record(SUPPRESSED_KIND, { subject: { kind, count, windowMs: RATE_WINDOW_MS } }),
})

// A failing store fails every row the same way, so a lost row is reported once per (stage, kind,
// code) per window, and the repeats as one count when the next window opens.
const failureWarnings = createRateGuard({
  windowMs: FAILURE_WARN_WINDOW_MS,
  max: 1,
  onSuppressed: (key, count) => log.warn('audit rows lost', fields({ key, repeats: count, windowMs: FAILURE_WARN_WINDOW_MS })),
})

// Context carries only short, non-secret identifiers: this line reaches the diagnostics bundle.
function warnLostRow(stage, kind, err, context = null) {
  const code = err?.code || err?.name || 'Error'
  if (!failureWarnings.admit(stage + ':' + kind + ':' + code)) return
  log.warn('audit row lost', fields({ ...(context || {}), stage, kind, code, msg: err?.message }))
}

export async function initAuditLog({ installId: id = null } = {}) {
  failureWarnings.reset()
  bee = createLocalBee(AUDIT_BEE_NAME)
  await bee.ready()
  installId = id
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

/** @internal */
export function isAuditReady() {
  return bee !== null
}

// The open handle, or null while the log is closed or being truncated.
export function auditBee() {
  return bee
}

export async function closeAuditLog() {
  const closing = bee
  bee = null                            // record() no-ops from here
  await writeChain.catch(() => {})      // every row already admitted lands before the core closes
  await closing?.close()
}

async function edgeSeq(reverse) {
  for await (const entry of bee.createReadStream(evtRange(), { reverse, limit: 1 })) {
    return seqOf(entry.key)
  }
  return -1
}

// The highest and lowest seq in the log, -1 when it is empty.
export function newestSeq() {
  return edgeSeq(true)
}

export function oldestSeq() {
  return edgeSeq(false)
}

// Fire-and-forget from every call site: auditing must never fail, slow, or throw into the
// operation it describes. Failures are logged and swallowed.
// Returns whether the row was ADMITTED (log open, enabled, within the rate budget). The
// write itself stays fire-and-forget, but callers that mirror "we recorded this" into
// durable state need to know when nothing was recorded at all.
export function record(kind, row = {}) {
  if (!bee || !config.enabled) return false
  if (kind !== SUPPRESSED_KIND && !rateGuard.admit(kind)) return false
  // The handle is captured HERE, not read again inside append: record() returning true is a
  // promise to the caller that the row is queued, and a close landing between this line and the
  // chain's turn would otherwise silently drop it. Closing still stops NEW records — `bee` is
  // nulled first, so the guard above rejects them — and the chain is drained before the core
  // closes, so every row already admitted lands.
  const target = bee
  writeChain = writeChain
    .then(() => append(kind, row, target))
    .catch((err) => warnLostRow('write', kind, err))
  return true
}

// For a row whose fields need a read first, such as a space name snapshotted into it. The read is
// part of the audit write, so its failure is a lost row, reported like a write failure and never
// passed to the caller: the returned promise always resolves, so a shutdown drain can hold it. A
// resolver returning null records nothing.
export function recordResolved(kind, resolve, { context = null } = {}) {
  return Promise.resolve()
    .then(resolve)
    .then((row) => { if (row) record(kind, row) })
    .catch((err) => {
      // A closed or disabled log would have written nothing, so there is no row to lose.
      if (!bee || !config.enabled) return
      warnLostRow('resolve', kind, err, context)
    })
}

function withSelfIdentity(actor) {
  if (!actor || actor.type !== ACTOR_TYPE.SELF) return actor
  return selfActor(actor.key ?? selfIdentity.key, actor.name ?? selfIdentity.name)
}

async function append(kind, fields, target) {
  if (target.closed) return
  const now = Date.now()
  const seq = nextSeq++
  const rec = buildRecord({
    ...fields,
    actor: withSelfIdentity(fields.actor),
    kind,
    seq,
    ts: now,
    tzOffset: -new Date(now).getTimezoneOffset(),
    installId,
  })
  const batch = target.batch()
  await batch.put(evtKey(seq), rec)
  await batch.put(indexKeyOf(rec), seq)
  await batch.flush()
}

// Awaits everything queued so far. The read and reclaim siblings need the log settled;
// instrumentation call sites never do.
export async function flushAudit() {
  await writeChain.catch(() => {})
}

export function getAuditConfig() {
  return { ...config }
}

export async function setAuditConfig(patch = {}) {
  config = normalizeConfig(patch, config)
  if (bee) await bee.put(CONFIG_KEY, config)
  return { ...config }
}

// Empties the tree in place. `truncate(0)` drops the blocks while the handle stays valid, where
// purge-and-recreate reopens corestore's stale cached tracker and every later read hangs. The
// handle is nulled for the window so record() no-ops rather than appending into a truncating
// core; rows admitted before the call land first.
export async function truncateLog() {
  if (!bee) return
  await flushAudit()
  const live = bee
  bee = null
  try {
    await live.core.truncate(0)
  } finally {
    bee = live
  }
  nextSeq = 0
  rateGuard.reset()
}
