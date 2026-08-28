// One runner over N per-space queues. Bulk slots (`concurrency`) are handed out round-robin
// across spaces with queued work, with one reservation: while more than one space has work no
// space may hold every bulk slot, so a space that just enqueued finds a slot immediately instead
// of waiting out another space's multi-gigabyte file. Scheduling is non-preemptive — a running
// hash holds its slot — so interactive items (a watcher event: the user just did this) get an
// EXPRESS lane on top of the bulk slots: one may always start, even while every bulk slot is
// held by a multi-minute hash, and an eligible interactive head is always picked before bulk.
import { PRIORITY } from './work-item.js'
import { createPublishQueue } from './publish-queue.js'

const EXPRESS_LANES = 1

const tallyKey = (spaceId, shareId) => spaceId + '\0' + shareId
const isIdle = (q) => { const s = q.stats(); return s.queued + s.running === 0 }

function heldBy(running, spaceId) {
  let n = 0
  for (const it of running) if (it.spaceId === spaceId) n += 1
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

function describeShare(queues, running, tallies, spaceId, shareId, order, concurrency) {
  const q = queues.get(spaceId)
  const t = tallies.get(tallyKey(spaceId, shareId))
  let active = 0
  for (const it of running) if (it.spaceId === spaceId && it.shareId === shareId) active += 1
  return {
    queued: Math.max(0, (q?.pendingForShare(shareId) ?? 0) - active),
    running: active,
    done: (t?.uploaded ?? 0) + (t?.deleted ?? 0),
    failed: t?.failed ?? 0,
    totalOnDisk: t?.totalOnDisk ?? null,
    bytesQueued: q?.bytesForShare(shareId) ?? 0,
    order,
    concurrency,
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
  const tallies = createTallies()
  const drainWaiters = new Map()
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
    running.add(item)
    ;(async () => {
      let settlement
      try {
        const result = await execute(item)
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
        running.delete(item)
        queues.get(item.spaceId)?.settle(item, settlement)
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
    const waiters = drainWaiters.get(key)
    if (!waiters) return
    drainWaiters.delete(key)
    const t = tallies.take(key)
    for (const resolve of waiters) resolve(t)
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

  function clear() {
    for (const q of queues.values()) q.cancel(() => true)
    queues.clear()
  }

  return {
    // Merges: the catch-up diff fires during a mount's drain, and a reset here would hand the
    // mount's whenDrained zeros.
    beginShare(spaceId, shareId, totalOnDisk) { tallies.begin(tallyKey(spaceId, shareId), totalOnDisk) },
    enqueue(spec) {
      const r = queueFor(spec.spaceId).enqueue(spec)
      pump()
      return r
    },
    enqueueMany(specs) {
      for (const s of specs) queueFor(s.spaceId).enqueue(s)
      pump()
    },
    whenDrained(spaceId, shareId) {
      const key = tallyKey(spaceId, shareId)
      const q = queues.get(spaceId)
      if (!q || q.pendingForShare(shareId) === 0) return Promise.resolve(tallies.take(key))
      return new Promise((resolve) => {
        const list = drainWaiters.get(key) || []
        list.push(resolve)
        drainWaiters.set(key, list)
      })
    },
    // Releases the pass NOW (its callers see `cancelled`), while a running item keeps its slot
    // and its place in the queue until the executor honours the abort.
    cancelShare(spaceId, shareId) {
      const q = queues.get(spaceId)
      const n = q?.cancel((it) => it.shareId === shareId) ?? 0
      const key = tallyKey(spaceId, shareId)
      if (q && q.pendingForShare(shareId) > 0) cancelling.add(key)
      tallies.cancel(key)
      releaseWaiters(key)
      if (!q || isIdle(q)) onSpaceIdle?.(spaceId)
      return n
    },
    async cancelSpace(spaceId, { settleMs = 5000 } = {}) {
      const n = queues.get(spaceId)?.cancel(() => true) ?? 0
      queues.delete(spaceId)
      for (const key of [...drainWaiters.keys()]) {
        if (key.startsWith(spaceId + '\0')) { tallies.cancel(key); releaseWaiters(key) }
      }
      const deadline = Date.now() + settleMs
      while ([...running].some((it) => it.spaceId === spaceId) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      return n
    },
    isPending(spaceId, shareId, relPath) { return !!queues.get(spaceId)?.isPending(shareId, relPath) },
    isSpaceIdle(spaceId) { const q = queues.get(spaceId); return !q || isIdle(q) },
    statusFor(spaceId, shareId) { return describeShare(queues, running, tallies, spaceId, shareId, order(), concurrency()) },
    stop() { stopped = true; clear() },
    _reset() {
      stopped = false
      clear()
      running.clear()
      tallies.clear()
      drainWaiters.clear()
      cancelling.clear()
      lastServed = null
    },
    _running: running,
  }
}
