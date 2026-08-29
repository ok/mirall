// Sender-side download indicator: who is currently pulling a file we own, and how far they have
// got. Fed by the overlay serve path (protocol-v2 _onContentRequest/_onChunkNeed: start, per-chunk
// bytes, end, control, resume baseline), aggregated per file and read by the renderer over worker
// IPC in two tiers: a cheap always-on summary (peer set + aggregate bytes, drives the collapsed
// avatar stack) and a per-peer detail stream emitted only for files whose row is expanded
// (detailSubs), so no per-peer progress is pushed that nobody is looking at. It owns nothing the
// backend needs, so it lives beside the backend rather than inside it.
import { serveIndex } from './backends/overlay/overlay-serve-index.js'
import { record } from '../audit/audit-log.js'
import { createSessionStore, sessionKey } from '../audit/audit-sessions.js'
import { getConnectedMemberMeta } from './swarm.js'
import { LOOSE_SHARE_ID } from './transfer-id.js'
import { getSpace } from '../spaces/space.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'

const log = createLogger('serve-ledger')

let ipcRef = null
let current = null

const LEDGER_SEP = String.fromCharCode(0)
const SUMMARY_THROTTLE_MS = 750
const DETAIL_THROTTLE_MS = 250
const IDLE_SWEEP_MS = 10000
const IDLE_DROP_MS = 30000
// Backstop for a paused row whose peer vanished without a clean onclose. Far longer
// than IDLE_DROP_MS (a deliberate pause should stay visible) but bounded, so a dead
// connection that never fired onclose can't leak the avatar forever.
const PAUSED_DROP_MS = 300000
// Backstop for a leaked detail subscription (a renderer reload never sends the
// unsubscribe): a sub with no download entry for this long is evicted so the sweep
// timer can't re-arm forever. A dropdown legitimately open on a file that quiet is
// already showing the empty set; reopening it re-subscribes.
const DETAIL_SUB_QUIET_MS = 300000

// `bytes` is DISPLAY-progress = max(bytes we served, the downloader's reported have) — a
// hybrid of observed serves and a downloader-asserted floor, NOT pure upload accounting.
const downloads = new Map()     // fileKey → { spaceId, path, peers: Map<profileKey, { bytes, total, lastTs, paused }> }
const detailSubs = new Map()    // fileKey → { n, spaceId, path } (a row is subscribed while n > 0; identity kept so the sweep can push an authoritative — possibly empty — snapshot)
const lastSummaryAt = new Map() // fileKey → ts (throttle)
const lastDetailAt = new Map()  // fileKey → ts (throttle)
const hashKeys = new Map()      // contentHash → fileKey[] (resolved once at serve start; the per-chunk path reads this, not the serve index)
const pendingControls = new Map() // contentHash\0from → 'paused'|'stopped' (control that arrived before the serve started; drained by onServeStart)
const pendingBaselines = new Map() // contentHash\0from → have (resume baseline that arrived before the serve started; drained by onServeStart)
let idleTimer = null

function fileKey(spaceId, path) { return spaceId + LEDGER_SEP + path }
function pcKey(contentHash, from) { return contentHash + LEDGER_SEP + from }
function rendererPath(shareId, relPath) { return shareId === LOOSE_SHARE_ID ? '/' + relPath : relPath }
function baseName(relPath) {
  if (typeof relPath !== 'string') return null
  const i = relPath.lastIndexOf('/')
  return i >= 0 ? relPath.slice(i + 1) : relPath
}

function emitBoth(key, force, now = Date.now()) {
  emitSummary(key, force, now)
  if (detailSubs.has(key)) emitDetail(key, force, now)
}

// Iterate the live serve entries for (contentHash, from) — the per-row scaffold shared by
// the chunk-served, paused, and baseline updates. fn(entry, key, now); a plain return skips
// the row (the loop continues).
function forEachServeEntry(contentHash, from, fn) {
  const keys = hashKeys.get(contentHash)
  if (!keys) return
  const now = Date.now()
  for (const key of keys) {
    const d = downloads.get(key)
    const entry = d?.peers.get(from)
    if (!entry) continue
    fn(entry, key, now)
  }
}

// Every recordServeSession() still in flight. The write is a spaces-bee read followed by an
// audit-bee write in a microtask nobody holds, so without this the shutdown can close either bee
// between the two — which is why a transfer interrupted by quitting recorded nothing.
const recording = new Set()

// One audit row per file served, not one per chunk or per reconnect. `from` is the requester's
// profile key, already Noise-authenticated by the serve gate — that is what makes the row
// attributable rather than a claim.
const serveSessions = createSessionStore()
const SERVE_SESSION_MAX_IDLE_MS = 300000

function auditServeKey(contentHash, from) {
  return sessionKey(contentHash, from)
}

// Names are resolved at record time, not at serve start: they must be snapshotted into the row
// (nothing is joined at render time), and the live handshake meta is the freshest source while
// the peer is still connected — which it is, having just pulled the bytes.
function recordServeSession(session) {
  if (!session || session.bytes <= 0) return
  const meta = session.meta || {}
  const pending = getSpace(meta.spaceId).then((space) => {
    const live = getConnectedMemberMeta(meta.spaceId, meta.from)
    const persisted = (space?.members || []).find((m) => m.publicKey === meta.from)
    record('serve.completed', {
      actor: { type: 'peer', key: meta.from ?? null, name: live?.displayName || persisted?.displayName || null },
      space: { id: meta.spaceId, name: space?.name ?? null },
      target: { kind: 'file', id: meta.contentHash ?? null, name: meta.fileName ?? null },
      subject: { bytes: session.bytes, total: session.total || null, durationMs: session.durationMs, path: meta.path ?? null },
    })
  }).catch((err) => log.debug('serve audit failed:', err.message))
  recording.add(pending)
  pending.finally(() => recording.delete(pending))
}

export function onServeStart({ from, contentHash, total }) {
  if (!from) return
  // Content-addressed: one hash can back several (space, share, path) rows when
  // identical bytes are advertised under more than one name. The sender only has
  // the hash — not the requester's intended path — so the indicator legitimately
  // appears on every row advertising the served hash.
  const refs = serveIndex.refsFor(contentHash)
  if (refs.length === 0) {
    // No row advertises this hash yet — discard any stash so it can't leak onto a future
    // unrelated serve of the same hash+peer.
    const pk = pcKey(contentHash, from)
    pendingControls.delete(pk)
    pendingBaselines.delete(pk)
    return
  }
  const keys = []
  for (const { spaceId, shareId, relPath } of refs) {
    const path = rendererPath(shareId, relPath)
    const key = fileKey(spaceId, path)
    keys.push(key)
    let d = downloads.get(key)
    if (!d) downloads.set(key, (d = { spaceId, path, peers: new Map() }))
    // Preserve an already-tracked peer's accumulated bytes: a pause→resume re-issues
    // the content-request, and resetting to 0 would both rewind the bar and — since
    // resume re-fetches only the missing chunks — keep bytes below total forever.
    const prev = d.peers.get(from)
    // paused:false — resume re-issues the content-request and lands here, clearing the flag.
    d.peers.set(from, { bytes: prev?.bytes ?? 0, total: total || prev?.total || 0, lastTs: Date.now(), paused: false })
    // A fresh serve wakes a dormant detail subscription (see runIdleSweep) so an open
    // dropdown that sat quiet past the window starts streaming again without a reopen.
    const sub = detailSubs.get(key)
    if (sub) sub.quietSince = 0
    emitBoth(key, true)
  }
  // Resolve hash→keys once so the per-chunk path below never re-parses the serve index.
  hashKeys.set(contentHash, keys)
  const first = refs[0]
  serveSessions.start(auditServeKey(contentHash, from), {
    now: Date.now(),
    total: total || 0,
    meta: {
      from,
      contentHash,
      spaceId: first.spaceId,
      path: rendererPath(first.shareId, first.relPath),
      fileName: baseName(first.relPath),
    },
  })
  // Apply a pause/stop that raced ahead of the serve-prep (it was stashed because
  // hashKeys wasn't populated yet).
  const pk = pcKey(contentHash, from)
  const pending = pendingControls.get(pk)
  if (pending) {
    pendingControls.delete(pk)
    if (pending === 'stopped') onServeEnd({ from, contentHash })
    else onServePaused({ from, contentHash })
  }
  const baseline = pendingBaselines.get(pk)
  if (baseline != null) {
    pendingBaselines.delete(pk)
    applyBaseline(from, contentHash, baseline)
  }
  scheduleIdleSweep()
}

// Route a downloader pause/stop control. If the serve hasn't started yet (hashKeys
// not populated), stash it so onServeStart applies it — otherwise the control races
// ahead of the async serve-prep and is lost.
export function onServeControl({ from, contentHash, state }) {
  if (!from) return
  if (!hashKeys.has(contentHash)) {
    pendingControls.set(pcKey(contentHash, from), state === 'stopped' ? 'stopped' : 'paused')
    return
  }
  if (state === 'stopped') onServeEnd({ from, contentHash })
  else onServePaused({ from, contentHash })
}

// A downloader reported its on-disk have-bytes for a hash we serve. Raise the entry's
// bytes to the reported have — never lower it (we may already have served more) — so the
// bar mirrors the downloader's true progress, not only the bytes we re-serve. The value is
// downloader-asserted, so it is DISPLAY-progress only: it caps at total and NEVER
// completes/drops the row (a peer can't self-hide by claiming have>=total) — only real
// served bytes, serve-end, or the idle sweep drop a row. Throttled like onChunkServed so a
// peer spamming frames can't flood the renderer. Stashed if the serve hasn't started yet.
export function onServeBaseline({ from, contentHash, have }) {
  if (!from || !have) return
  if (!hashKeys.has(contentHash)) {
    const pk = pcKey(contentHash, from)
    pendingBaselines.set(pk, Math.max(have, pendingBaselines.get(pk) || 0))
    return
  }
  applyBaseline(from, contentHash, have)
}

function applyBaseline(from, contentHash, have) {
  forEachServeEntry(contentHash, from, (entry, key, now) => {
    const capped = entry.total > 0 ? Math.min(have, entry.total) : have
    if (capped <= entry.bytes) return
    entry.bytes = capped
    entry.lastTs = now
    emitBoth(key, false, now)
  })
}

// A downloader paused (kept its partial). Mark the entry so the indicator shows a
// paused state; the idle sweep then keeps it for PAUSED_DROP_MS (vs IDLE_DROP_MS for
// active rows) so a deliberate pause stays visible but a vanished peer still gets reaped.
export function onServePaused({ from, contentHash }) {
  if (!from) return
  forEachServeEntry(contentHash, from, (entry, key, now) => {
    entry.paused = true
    entry.lastTs = now
    emitBoth(key, true, now)
  })
}

export function onChunkServed({ from, contentHash, bytes }) {
  if (!from) return
  forEachServeEntry(contentHash, from, (entry, key, now) => {
    // Don't clear `paused` here: trailing in-flight chunks served after a pause are
    // drain, not a resume. Resume goes through onServeStart, which clears the flag.
    entry.bytes += bytes
    entry.lastTs = now
    if (entry.total > 0 && entry.bytes >= entry.total) { dropPeer(key, from); return }
    emitBoth(key, false, now)
  })
  // Tracked separately from the per-row entries above: those are cleared the moment a row
  // completes, while the audit session must survive until the transfer is genuinely over.
  //
  // Completion has to be detected HERE. The protocol emits onServeEnd only on channel close or
  // grant revocation — never on a successful transfer — and the idle sweep stops being scheduled
  // once the last live row is dropped, so neither the end callback nor the reaper would ever
  // close a completed serve. Without this the owner records nothing when a peer downloads a file.
  const auditKey = auditServeKey(contentHash, from)
  const session = serveSessions.advance(auditKey, { now: Date.now(), delta: bytes })
  if (session && session.total > 0 && session.bytes >= session.total) {
    recordServeSession(serveSessions.end(auditKey, { now: Date.now() }))
  }
}

export function onServeEnd({ from, contentHash }) {
  if (!from) return
  recordServeSession(serveSessions.end(auditServeKey(contentHash, from), { now: Date.now() }))
  pendingControls.delete(pcKey(contentHash, from))
  pendingBaselines.delete(pcKey(contentHash, from))
  const keys = hashKeys.get(contentHash)
  if (!keys) return
  for (const key of keys) dropPeer(key, from)
  // Forget the cache once no row for this hash has a downloader left (the
  // completion path leaves a benign stale entry that the next serve overwrites).
  if (keys.every((key) => !downloads.has(key))) hashKeys.delete(contentHash)
}

function dropPeer(key, from) {
  const d = downloads.get(key)
  if (!d || !d.peers.delete(from)) return
  if (d.peers.size === 0) {
    ipcRef?.emit('event:awareness', { channel: 'serving', spaceId: d.spaceId, path: d.path, peers: [], bytes: 0, total: 0, pausedKeys: [] })
    if (detailSubs.has(key)) ipcRef?.emit('event:awareness', { channel: 'serving-detail', spaceId: d.spaceId, path: d.path, peers: [] })
    downloads.delete(key)
    lastSummaryAt.delete(key)
    lastDetailAt.delete(key)
    return
  }
  emitBoth(key, true)
}

function emitSummary(key, force, now = Date.now()) {
  const d = downloads.get(key)
  if (!d) return
  if (!force && now - (lastSummaryAt.get(key) || 0) < SUMMARY_THROTTLE_MS) return
  lastSummaryAt.set(key, now)
  ipcRef?.emit('event:awareness', { channel: 'serving', ...summaryPayload(d) })
}

// bytes/total are aggregate SUMS across the downloaders (so bytes/total is the
// average progress for the collapsed bar) — NOT a single file's size. With N
// downloaders of an F-byte file, total ≈ N·F; never read it as the file size.
function summaryPayload(d) {
  let bytes = 0
  let total = 0
  const peers = []
  const pausedKeys = []
  for (const [profileKey, e] of d.peers) { peers.push(profileKey); bytes += e.bytes; total += e.total; if (e.paused) pausedKeys.push(profileKey) }
  return { spaceId: d.spaceId, path: d.path, peers, bytes, total, pausedKeys }
}

// Snapshot of every live serve row for a space (the same payload the summary events
// carry) — requested by the renderer on mount so a view opened mid-download shows the
// indicator immediately instead of waiting for the next sweep re-announce.
export function listServeSummaries(spaceId) {
  const out = []
  for (const d of downloads.values()) {
    if (d.spaceId === spaceId) out.push(summaryPayload(d))
  }
  return out
}

function emitDetail(key, force, now = Date.now()) {
  const d = downloads.get(key)
  if (!d) return
  if (!force && now - (lastDetailAt.get(key) || 0) < DETAIL_THROTTLE_MS) return
  lastDetailAt.set(key, now)
  ipcRef?.emit('event:awareness', { channel: 'serving-detail', spaceId: d.spaceId, path: d.path, peers: serveSnapshot(key).peers })
}

function serveSnapshot(key) {
  const d = downloads.get(key)
  if (!d) return { peers: [] }
  const peers = []
  for (const [profileKey, e] of d.peers) peers.push({ peerKey: profileKey, bytes: e.bytes, total: e.total, paused: !!e.paused })
  return { peers }
}

export function subscribeServeDetail(spaceId, path) {
  const key = fileKey(spaceId, path)
  // Refcount so two open surfaces on the same row don't kill each other's stream:
  // detail flows while the count is > 0; one consumer closing only decrements.
  const cur = detailSubs.get(key)
  detailSubs.set(key, { n: (cur?.n || 0) + 1, spaceId, path })
  // A subscription on a quiet file must still get sweep-driven authoritative frames.
  scheduleIdleSweep()
  return serveSnapshot(key)
}

// Read the current serve detail without touching the subscription refcount — used by the
// integration suite to assert snapshots without arming a stream.
export function getServeDetail(spaceId, path) {
  return serveSnapshot(fileKey(spaceId, path))
}

export function unsubscribeServeDetail(spaceId, path) {
  const key = fileKey(spaceId, path)
  const cur = detailSubs.get(key)
  const n = (cur?.n || 0) - 1
  if (n > 0) detailSubs.set(key, { ...cur, n })
  else { detailSubs.delete(key); lastDetailAt.delete(key) }
  return { ok: true }
}

// Push the authoritative snapshot for a subscribed file — including the empty set, so a missed
// "peer gone" frame self-corrects on the next sweep instead of leaving a ghost row in the
// expanded dropdown. This replaces the renderer's serving:detail-get poll.
function emitDetailAuthoritative(key, now = Date.now()) {
  const sub = detailSubs.get(key)
  if (!sub) return
  lastDetailAt.set(key, now)
  ipcRef?.emit('event:awareness', { channel: 'serving-detail', spaceId: sub.spaceId, path: sub.path, peers: serveSnapshot(key).peers })
}

function scheduleIdleSweep() {
  if (idleTimer || !current) return
  idleTimer = current.timers.setTimeout(runIdleSweep, IDLE_SWEEP_MS)
}

// A peer that stops requesting bytes without completing (e.g. it found the rest
// from another holder, or dropped) is evicted after IDLE_DROP_MS so its avatar
// doesn't linger; a paused peer gets the longer PAUSED_DROP_MS so a deliberate pause
// stays visible. Disconnect (onServeEnd) and completion handle the common cases; this
// is the backstop. Re-arms itself while any download is live.
function runIdleSweep(now = Date.now()) {
  idleTimer = null
  const stale = []
  for (const [key, d] of downloads) {
    for (const [from, e] of d.peers) {
      const ttl = e.paused ? PAUSED_DROP_MS : IDLE_DROP_MS
      if (now - e.lastTs > ttl) stale.push([key, from])
    }
  }
  for (const [key, from] of stale) dropPeer(key, from)
  // A peer that vanished without an end frame would otherwise pin its session forever; reaping
  // still records what was actually served rather than discarding it.
  for (const session of serveSessions.reap(now, SERVE_SESSION_MAX_IDLE_MS)) recordServeSession(session)
  // Re-announce every still-live row (active AND paused): the renderer's soft-state TTL only
  // survives if summaries re-arrive without chunk traffic — a paused downloader otherwise
  // emits exactly one frame and is erased at the renderer TTL while this ledger keeps it for
  // PAUSED_DROP_MS. The sweep cadence IS the re-announce throttle — for detail too: every
  // subscribed file gets its authoritative (possibly empty) snapshot pushed each tick.
  for (const key of downloads.keys()) emitSummary(key, true, now)
  // A sub quiet past the window goes DORMANT, not evicted: it stops receiving sweep
  // frames and stops holding the timer (a leaked subscription costs one map entry, not a
  // forever-armed sweep), but stays registered so a new serve for its key (onServeStart)
  // wakes it — an open dropdown is never starved after a quiet spell.
  let wakefulSubs = 0
  for (const [key, sub] of detailSubs) {
    if (downloads.has(key)) sub.quietSince = 0
    else if (!sub.quietSince) sub.quietSince = now
    if (sub.quietSince && now - sub.quietSince > DETAIL_SUB_QUIET_MS) continue
    wakefulSubs++
    emitDetailAuthoritative(key, now)
  }
  // Open audit sessions keep the sweep armed too. A serve that never reaches its total — the peer
  // found the rest from another holder, paused, or resumed from an existing partial — is closed
  // only by the reaper, and without this the sweep stops the moment the last live row drops and
  // those bytes are never recorded at all.
  if (downloads.size > 0 || wakefulSubs > 0 || serveSessions.size() > 0) scheduleIdleSweep()
}

export function _sweepServeLedgerNow(now) { runIdleSweep(now) }

function resetServeLedger() {
  serveSessions.clear()
  if (idleTimer) { current?.timers.clear(idleTimer); idleTimer = null }
  downloads.clear()
  detailSubs.clear()
  lastSummaryAt.clear()
  lastDetailAt.clear()
  hashKeys.clear()
  pendingControls.clear()
  pendingBaselines.clear()
}

export class ServeLedger extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('ipc') }

  async _open() {
    ipcRef = this.deps.ipc
    current = this
  }

  // Runs after the overlay teardown, which is what emits the serve-end events in the first place.
  // End the sessions still open (a peer that never closed cleanly served real bytes too), then
  // drain the writes those produce while the spaces and audit bees are both still open — the
  // start order in the boot root is what guarantees they are.
  async _close({ settleMs = 2000 } = {}) {
    for (const session of serveSessions.reap(Date.now(), 0)) recordServeSession(session)
    if (recording.size) {
      await Promise.race([
        Promise.allSettled([...recording]),
        new Promise((resolve) => { const t = setTimeout(resolve, settleMs); t.unref?.() }),
      ])
    }
    resetServeLedger()
    recording.clear()
    ipcRef = null
    current = null
  }
}
