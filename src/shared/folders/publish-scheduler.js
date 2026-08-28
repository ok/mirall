// One runner over N per-space queues. Slots are handed out round-robin across spaces with
// queued work, with two reservations: while more than one space has work no space may hold
// every slot, so a space that just enqueued finds a slot immediately instead of waiting out
// another space's multi-gigabyte file; and while an interactive item is eligible a bulk item may
// not take the last slot. Scheduling is non-preemptive — a running hash holds its slot.
import { PRIORITY } from './work-item.js'
import { createPublishQueue } from './publish-queue.js'

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
  const withWork = order.filter((s) => queues.get(s).peek())
  if (!withWork.length) return null
  const cap = withWork.length > 1 ? Math.max(1, concurrency - 1) : concurrency
  const eligible = new Set(withWork.filter((s) => heldBy(running, s) < cap))
  if (!eligible.size) return null
  const reserve = [...eligible].some((s) => queues.get(s).peek().priority === PRIORITY.INTERACTIVE)
  const start = order.indexOf(lastServed) + 1
  for (let i = 0; i < order.length; i++) {
    const spaceId = order[(start + i) % order.length]
    if (!eligible.has(spaceId)) continue
    const head = queues.get(spaceId).peek()
    if (head.priority === PRIORITY.BULK && reserve && running.size >= concurrency - 1) continue
    return { spaceId, item: queues.get(spaceId).take() }
  }
  return null
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
    bytesQueued: q?.stats().queuedBytes ?? 0,
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
  const tallies = new Map()
  const drainWaiters = new Map()
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
      while (running.size < concurrency()) {
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
        tally(item, result)
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

  function settleDrain(spaceId, shareId) {
    const q = queues.get(spaceId)
    if (q && q.pendingForShare(shareId) > 0) return
    const key = tallyKey(spaceId, shareId)
    const t = tallies.get(key) || null
    tallies.delete(key)
    const waiters = drainWaiters.get(key)
    drainWaiters.delete(key)
    if (t) onShareDrained?.(spaceId, shareId, t)
    if (waiters) for (const resolve of waiters) resolve(t)
    if (!q || isIdle(q)) onSpaceIdle?.(spaceId)
  }

  function clear() {
    for (const q of queues.values()) q.cancel(() => true)
    queues.clear()
  }

  return {
    // Merges: the catch-up diff fires during a mount's drain, and a reset here would hand the
    // mount's whenDrained zeros.
    beginShare(spaceId, shareId, totalOnDisk) {
      const key = tallyKey(spaceId, shareId)
      const cur = tallies.get(key)
      if (cur) cur.totalOnDisk = totalOnDisk
      else tallies.set(key, { uploaded: 0, deleted: 0, failed: 0, totalOnDisk })
    },
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
      if (!q || q.pendingForShare(shareId) === 0) {
        const t = tallies.get(key) || null
        tallies.delete(key)
        return Promise.resolve(t)
      }
      return new Promise((resolve) => {
        const list = drainWaiters.get(key) || []
        list.push(resolve)
        drainWaiters.set(key, list)
      })
    },
    cancelShare(spaceId, shareId) {
      const n = queues.get(spaceId)?.cancel((it) => it.shareId === shareId) ?? 0
      settleDrain(spaceId, shareId)
      return n
    },
    async cancelSpace(spaceId, { settleMs = 5000 } = {}) {
      const n = queues.get(spaceId)?.cancel(() => true) ?? 0
      queues.delete(spaceId)
      const deadline = Date.now() + settleMs
      while ([...running].some((it) => it.spaceId === spaceId) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      for (const key of [...drainWaiters.keys()]) {
        if (key.startsWith(spaceId + '\0')) settleDrain(spaceId, key.slice(spaceId.length + 1))
      }
      return n
    },
    isPending(spaceId, shareId, relPath) { return !!queues.get(spaceId)?.isPending(shareId, relPath) },
    isSpaceIdle(spaceId) { const q = queues.get(spaceId); return !q || isIdle(q) },
    statusFor(spaceId, shareId) { return describeShare(queues, running, tallies, spaceId, shareId, order(), concurrency()) },
    setOrder(next) { for (const q of queues.values()) q.setOrder(next) },
    stop() { stopped = true; clear() },
    _reset() {
      stopped = false
      clear()
      running.clear()
      tallies.clear()
      drainWaiters.clear()
      lastServed = null
    },
    _running: running,
  }
}
