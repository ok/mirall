// One runner over N per-space queues. Bulk slots (`concurrency`) are handed out round-robin
// across spaces with queued work, with one reservation: while more than one space has work no
// space may hold every bulk slot, so a space that just enqueued finds a slot immediately instead
// of waiting out another space's multi-gigabyte file. Scheduling is non-preemptive — a running
// hash holds its slot — so interactive items (a watcher event: the user just did this) get an
// EXPRESS lane on top of the bulk slots: one may always start, even while every bulk slot is
// held by a multi-minute hash, and an eligible interactive head is always picked before bulk.
import { OP, PRIORITY, itemKey, promiseOf } from './work-item.js'
import { createPublishQueue } from './publish-queue.js'
import { createPassLiveness } from '../core/pass-liveness.js'

const EXPRESS_LANES = 1

const tallyKey = (spaceId, shareId) => spaceId + '\0' + shareId
const isIdle = (q) => { const s = q.stats(); return s.queued + s.running === 0 }

function heldBy(running, spaceId) {
  let n = 0
  for (const it of running) if (it.spaceId === spaceId) n += 1
  return n
}

function heldForShare(items, spaceId, shareId) {
  let n = 0
  for (const it of items) if (it.spaceId === spaceId && it.shareId === shareId) n += 1
  return n
}

// Rotates over the FULL space order (not the eligible subset), so a space that drained between
// two picks does not reset the rotation to the front.
function selectNext(queues, running, concurrency, lastServed) {
  const order = [...queues.keys()]
  if (!order.some((s) => queues.get(s).peek())) return null
  const start = order.indexOf(lastServed) + 1
  const rotate = function* () { for (let i = 0; i < order.length; i++) yield order[(start + i) % order.length] }

  if (running.size < concurrency + EXPRESS_LANES) {
    for (const spaceId of rotate()) {
      const head = queues.get(spaceId).peek()
      if (head?.priority === PRIORITY.INTERACTIVE) return { spaceId, item: queues.get(spaceId).take() }
    }
  }
  if (running.size >= concurrency) return null
  const withWork = order.filter((s) => queues.get(s).peek())
  const cap = withWork.length > 1 ? Math.max(1, concurrency - 1) : concurrency
  for (const spaceId of rotate()) {
    if (!queues.get(spaceId).peek() || heldBy(running, spaceId) >= cap) continue
    return { spaceId, item: queues.get(spaceId).take() }
  }
  return null
}

// One pass's counts per (space, share). A tally lives from the pass's beginShare until its
// whenDrained collects it — never shorter, or a pass whose items all settled before it asked
// (retires take microseconds) would read zeros. A catch-up beginning mid-drain merges; a pass
// beginning after a cancelled one starts fresh.
function createTallies() {
  const tallies = new Map()
  return {
    get: (key) => tallies.get(key) || null,
    begin(key, totalOnDisk) {
      const cur = tallies.get(key)
      if (cur && !cur.cancelled) cur.totalOnDisk = totalOnDisk
      else tallies.set(key, { uploaded: 0, deleted: 0, failed: 0, totalOnDisk })
    },
    take(key) { const t = tallies.get(key) || null; tallies.delete(key); return t },
    // Marks the pass cancelled; whoever collects it sees the marker.
    cancel(key) {
      const t = tallies.get(key) || { uploaded: 0, deleted: 0, failed: 0, totalOnDisk: 0 }
      t.cancelled = true
      tallies.set(key, t)
      return t
    },
    clear: () => tallies.clear(),
  }
}

// "The lane reached state X": resolved from run()'s finally — the moment an executor returns —
// or by the bound. An event the scheduler observes anyway, so nobody polls for it.
function createWaiters() {
  const list = []
  return {
    add(pred, settleMs) {
      if (pred()) return Promise.resolve()
      return new Promise((resolve) => {
        const w = { pred, fire: null }
        const timer = setTimeout(() => { list.splice(list.indexOf(w), 1); resolve() }, settleMs)
        timer.unref?.()
        w.fire = () => { clearTimeout(timer); resolve() }
        list.push(w)
      })
    },
    settle() {
      for (const w of list.splice(0)) { if (w.pred()) w.fire(); else list.push(w) }
    },
  }
}

// Callers of whenDrained parked on a (space, share) until its pass settles.
function createDrainWaiters() {
  const waiting = new Map()
  return {
    wait(key) {
      return new Promise((resolve) => {
        const list = waiting.get(key) || []
        list.push(resolve)
        waiting.set(key, list)
      })
    },
    has: (key) => waiting.has(key),
    keys: () => [...waiting.keys()],
    release(key, value) {
      const list = waiting.get(key)
      if (!list) return
      waiting.delete(key)
      for (const resolve of list) resolve(value)
    },
    clear: () => waiting.clear(),
  }
}

function describeShare(queues, running, slots, tallies, spaceId, shareId, order, concurrency) {
  const q = queues.get(spaceId)
  const t = tallies.get(tallyKey(spaceId, shareId))
  const active = heldForShare(running, spaceId, shareId)
  // An evicted item holds no slot but has not returned, so it is still pending in the queue.
  // Counted on its own, or it would read as queued work nothing is doing.
  const stalled = slots.evictedForShare(spaceId, shareId)
  return {
    queued: Math.max(0, (q?.pendingForShare(shareId) ?? 0) - active - stalled),
    running: active,
    stalled,
    done: (t?.uploaded ?? 0) + (t?.deleted ?? 0),
    failed: t?.failed ?? 0,
    totalOnDisk: t?.totalOnDisk ?? null,
    bytesQueued: q?.bytesForShare(shareId) ?? 0,
    // Publish work only — `queued`/`running` above count retires too, and a delete is not an add.
    adding: Math.max(0, (q?.addingForShare(shareId) ?? 0) - slots.evictedAddsForShare(spaceId, shareId)),
    order,
    concurrency,
  }
}

// Every queued item is released as cancelled and the per-space queues go with them: what a stop
// does, and the one path that empties the lane rather than draining it.
function dropQueues(queues) {
  for (const q of queues.values()) q.cancel(() => true)
  queues.clear()
}

// The identity the supervisor keys a wedged item on. The item's own key is `shareId + relPath`,
// which is unique WITHIN a space because each space has its own queue — but the lane's liveness is
// one map across every space, and every space's loose files share the one LOOSE_SHARE_ID. Two
// spaces holding a same-named loose file would collide on a single entry: one space's settle would
// delete the other's heartbeat, and the still-running item would read healthy for the rest of its
// life. The space is what makes it an identity rather than a name.
// test seam
export const publishSlotKey = (spaceId, shareId, relPath) => spaceId + '\0' + itemKey(shareId, relPath)
const slotKey = (item) => publishSlotKey(item.spaceId, item.shareId, item.relPath)

// The lane's wedge bookkeeping — not "what is running" but "what is running and getting nowhere",
// the only question the supervisor asks — plus the items whose slot was reclaimed while their
// executor was still on them. An evicted item stays in the queue's byKey map, so its path cannot
// get a second executor; it is tracked here only so statusFor can report it.
function createSlotWatch({ running, queues, pump, concurrency }) {
  const liveness = createPassLiveness()
  const evicted = new Set()
  return {
    // A multi-gigabyte hash is legitimately slow, so elapsed time cannot be the signal — only an
    // item that is running AND not advancing is wedged. Returns the item's beat, bound to THIS
    // pass: a token the executor cannot outlive its own entry with.
    started(item) {
      const key = slotKey(item)
      const pass = liveness.started(key)
      return () => liveness.progress(key, pass)
    },
    settled(item) { evicted.delete(item); liveness.forget(slotKey(item)) },
    evictedForShare: (spaceId, shareId) => heldForShare(evicted, spaceId, shareId),
    // What a drain has to wait for besides `running`: an evicted item holds no slot but its
    // executor is still on the file. A stop() that treated it as finished would let the lifecycle
    // close the store underneath a live read.
    pending: () => evicted.size,
    pendingIn: (spaceId) => heldBy(evicted, spaceId),
    // The queue's own `adding` counter is only ever decremented by settle(), which an evicted
    // item's never-returning executor does not reach. Discounted here, or the share keeps
    // broadcasting "still indexing one file" to every member for the life of the process — for a
    // file the recovery gave up on.
    evictedAddsForShare: (spaceId, shareId) => {
      let n = 0
      for (const it of evicted) if (it.spaceId === spaceId && it.shareId === shareId && it.op !== OP.RETIRE) n += 1
      return n
    },
    // Rows carry the share id and the path — the worker log names a unit, the shareable
    // diagnostics bundle does not. An evicted item is reported UNCONDITIONALLY, not through its
    // heartbeat: it is still stuck, its executor still holds the file, and a row that vanished the
    // moment we acted on it would take its strike counter with it (the policy prunes counters for
    // rows nobody reports), so the give-up line that names the file could never fire.
    stalledItems({ now = Date.now(), windowMs } = {}) {
      const out = []
      const row = (item, verdict) => ({ key: slotKey(item), spaceId: item.spaceId, shareId: item.shareId, relPath: item.relPath, ...verdict })
      for (const item of running) {
        const verdict = liveness.verdict(slotKey(item), { now, windowMs })
        if (!verdict.ok) out.push(row(item, { ...verdict, evicted: false }))
      }
      for (const item of evicted) {
        out.push(row(item, { ok: false, detail: 'slot reclaimed; the executor has not returned', evicted: true }))
      }
      return out
    },
    // Reclaim a wedged item's slot. The item is NOT settled here: leaving it in the queue is what
    // keeps its path guarded while the executor is still on it, and the settle its executor's
    // return already performs unwinds the accounting for both cases. Publishing resumes for every
    // other file the instant this returns.
    evict(key) {
      // Capped at `concurrency` evictions: every freed slot is one more abandoned executor holding a
      // file handle and its read buffers, so without a ceiling a dead mount accumulates one per stall
      // window for the life of the process. Past it the item keeps its slot and the supervisor
      // reports it, spends its budget and gives up on it by name.
      if (evicted.size >= concurrency()) return false
      for (const item of running) {
        if (slotKey(item) !== key) continue
        // Through the queue rather than by hand: it releases the callers waiting on this run,
        // drops a queued publish rerun (but never a queued retire, which is disk state), and sets
        // the abort the executor will honour if it ever reaches a checkpoint.
        queues.get(item.spaceId)?.cancel((it) => it === item)
        running.delete(item)
        evicted.add(item)
        liveness.forget(slotKey(item))
        pump()
        return true
      }
      return false
    },
  }
}

export function createPublishScheduler({
  execute,
  concurrency: rawConcurrency = () => 2,
  order = () => 'fifo',
  onProgress = null,
  onShareDrained = null,
  onSpaceIdle = null,
  log = null,
} = {}) {
  const concurrency = () => Math.max(1, rawConcurrency())
  const queues = new Map()
  const running = new Set()
  const slots = createSlotWatch({ running, queues, pump, concurrency })
  const tallies = createTallies()
  const waiters = createWaiters()
  const drainWaiters = createDrainWaiters()
  // Shares cancelled while an item of theirs was still executing: the drain hook still fires when
  // that item settles, so the cancelled index's revert is flushed and announced like a finished one.
  const cancelling = new Set()
  let lastServed = null
  let pumping = false
  let stopped = false

  const queueFor = (spaceId) => {
    let q = queues.get(spaceId)
    if (!q) queues.set(spaceId, (q = createPublishQueue({ order: order() })))
    return q
  }

  function pump() {
    if (pumping || stopped) return
    pumping = true
    try {
      while (running.size < concurrency() + EXPRESS_LANES) {
        const next = selectNext(queues, running, concurrency(), lastServed)
        if (!next) break
        lastServed = next.spaceId
        run(next.item)
      }
    } finally {
      pumping = false
    }
  }

  function run(item) {
    // Captured, not looked up in the finally: cancelSpace deletes a space's queue, and settling a
    // late-returning item against the queue that REPLACED it decrements counters for work that
    // queue never admitted and deletes the live item holding that path.
    const queue = queues.get(item.spaceId)
    running.add(item)
    const beat = slots.started(item)
    // An item STARTING moves a file from queued to running, and for a multi-GB hash that is the last
    // shape change for minutes — reporting only from the settle hook below left every consumer of
    // statusFor() describing a queue that had already moved on. Bounded by the consumer's own
    // coalescer, so a burst of starts is one report.
    onProgress?.(item.spaceId, item.shareId)
    ;(async () => {
      let settlement
      try {
        const result = await execute(item, { beat })
        settlement = { outcome: result?.outcome === 'failed' ? 'failed' : 'done', result }
        // A cancelled item that ran to completion anyway counts for nobody: its pass is gone.
        if (!item.signal.aborted) tally(item, result)
      } catch (err) {
        settlement = { outcome: item.signal.aborted ? 'cancelled' : 'failed', error: err }
        if (!item.signal.aborted) {
          tally(item, { outcome: 'failed' })
          log?.warn('publish item failed:', item.shareId, item.relPath, '-', err.message)
        }
      } finally {
        // Identity-guarded by the queue, not here: an evicted item was removed from `running`
        // while its executor was still on it, and it settles here exactly as one that kept its
        // slot — which is what unwinds the queue's accounting for both cases.
        running.delete(item)
        slots.settled(item)
        queue?.settle(item, settlement)
        waiters.settle()
        onProgress?.(item.spaceId, item.shareId)
        settleDrain(item.spaceId, item.shareId)
        pump()
      }
    })()
  }

  function tally(item, result) {
    const t = tallies.get(tallyKey(item.spaceId, item.shareId))
    if (!t) return
    if (result?.outcome === 'published') t.uploaded += 1
    else if (result?.outcome === 'retired') t.deleted += 1
    else if (result?.outcome === 'failed') t.failed += 1
  }

  // Hands the pass's tally to the callers waiting on it, if any; otherwise it stays for the
  // whenDrained that has not asked yet.
  function releaseWaiters(key) {
    if (drainWaiters.has(key)) drainWaiters.release(key, tallies.take(key))
  }

  // After an item settled. Order matters: the space's batch closes (onSpaceIdle) BEFORE the share
  // is reported drained, so the drained hook can await the close; and the drained hook runs
  // BEFORE the tally is collected, so the terminal progress it flushes still carries the counts.
  function settleDrain(spaceId, shareId) {
    const q = queues.get(spaceId)
    if (q && q.pendingForShare(shareId) > 0) return
    if (!q || isIdle(q)) onSpaceIdle?.(spaceId)
    const key = tallyKey(spaceId, shareId)
    const t = tallies.get(key)
    if (t || cancelling.delete(key)) onShareDrained?.(spaceId, shareId, t)
    releaseWaiters(key)
  }

  return {
    // Merges: the catch-up diff fires during a mount's drain, and a reset here would hand the
    // mount's whenDrained zeros.
    beginShare(spaceId, shareId, totalOnDisk) { tallies.begin(tallyKey(spaceId, shareId), totalOnDisk) },
    // Admitting work is a shape change too, and for the lane that matters most: with every slot
    // held by a long hash, an enqueue starts nothing, so without this the only report would be the
    // one from whichever item settles next — a queue depth of 40 read as 0 for the length of a
    // multi-GB hash. Reported AFTER pump(), so the counts already reflect anything it started.
    enqueue(spec) {
      const r = queueFor(spec.spaceId).enqueue(spec)
      pump()
      onProgress?.(spec.spaceId, spec.shareId)
      return r
    },
    enqueueMany(specs) {
      const touched = new Map()
      for (const spec of specs) {
        queueFor(spec.spaceId).enqueue(spec)
        touched.set(tallyKey(spec.spaceId, spec.shareId), spec)
      }
      pump()
      for (const spec of touched.values()) onProgress?.(spec.spaceId, spec.shareId)
    },
    whenDrained(spaceId, shareId) {
      const key = tallyKey(spaceId, shareId)
      const q = queues.get(spaceId)
      if (!q || q.pendingForShare(shareId) === 0) return Promise.resolve(tallies.take(key))
      return drainWaiters.wait(key)
    },
    // Releases the pass NOW (its callers see `cancelled`), while a running item keeps its slot
    // and its place in the queue until the executor honours the abort.
    cancelShare(spaceId, shareId) {
      const q = queues.get(spaceId)
      const n = q?.cancel((it) => it.shareId === shareId).length ?? 0
      const key = tallyKey(spaceId, shareId)
      if (q && q.pendingForShare(shareId) > 0) cancelling.add(key)
      tallies.cancel(key)
      releaseWaiters(key)
      if (!q || isIdle(q)) onSpaceIdle?.(spaceId)
      // Emptying the queue is a shape change like any other, and the one nothing else covers: with
      // no item of this share holding a slot there is no settle to follow, so without this the last
      // report anyone saw is the pre-cancel depth.
      onProgress?.(spaceId, shareId)
      return n
    },
    // One path's item, no pass semantics. `exited` resolves once its executor has returned (at
    // once for an item that never ran) — what a caller that must write after the tail waits for.
    cancelPath(spaceId, shareId, relPath) {
      const items = queues.get(spaceId)?.cancel((it) => it.shareId === shareId && it.relPath === relPath) ?? []
      if (items.length) settleDrain(spaceId, shareId)
      return { cancelled: items.length, exited: Promise.all(items.map((it) => promiseOf(it.exit))) }
    },
    async cancelSpace(spaceId, { settleMs = 5000 } = {}) {
      const n = queues.get(spaceId)?.cancel(() => true).length ?? 0
      queues.delete(spaceId)
      for (const key of [...drainWaiters.keys()]) {
        if (key.startsWith(spaceId + '\0')) { tallies.cancel(key); releaseWaiters(key) }
      }
      await waiters.add(() => heldBy(running, spaceId) + slots.pendingIn(spaceId) === 0, settleMs)
      return n
    },
    stalledItems: slots.stalledItems,
    evict: slots.evict,
    isPending(spaceId, shareId, relPath) { return !!queues.get(spaceId)?.isPending(shareId, relPath) },
    pendingRelPaths(spaceId, shareId) { return queues.get(spaceId)?.pendingRelPaths(shareId) ?? [] },
    isSpaceIdle(spaceId) { const q = queues.get(spaceId); return !q || isIdle(q) },
    statusFor(spaceId, shareId) { return describeShare(queues, running, slots, tallies, spaceId, shareId, order(), concurrency()) },
    // Resolves once every executor has returned (or after the bound); nothing starts after it.
    stop({ settleMs = 0 } = {}) {
      stopped = true
      dropQueues(queues)
      return waiters.add(() => running.size + slots.pending() === 0, settleMs)
    },
    _running: running,
  }
}
