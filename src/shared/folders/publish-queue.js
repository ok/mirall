// One space's work queue: a heap in the configured order plus a byKey map that guarantees at
// most one live item per path. A second request for a path folds into the queued item, or marks
// a running one dirty for exactly one rerun — it can never start a second read of the file.
// Re-sorted and cancelled entries are dropped lazily: each push records the item's gen, and a
// popped entry whose gen no longer matches is skipped.
import { STATE, PRIORITY, itemKey, factsOf, createItem, comparatorFor } from './work-item.js'

function createHeap(cmp) {
  const a = []
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1
      if (cmp(a[i], a[p]) >= 0) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < a.length && cmp(a[l], a[m]) < 0) m = l
      if (r < a.length && cmp(a[r], a[m]) < 0) m = r
      if (m === i) break
      ;[a[i], a[m]] = [a[m], a[i]]
      i = m
    }
  }
  return {
    push(x) { a.push(x); up(a.length - 1) },
    pop() {
      if (!a.length) return null
      const top = a[0]
      const last = a.pop()
      if (a.length) { a[0] = last; down(0) }
      return top
    },
    peek() { return a.length ? a[0] : null },
    drain() { const out = a.slice(); a.length = 0; return out },
  }
}

const resolveAll = (list, value) => { for (const resolve of list.splice(0)) resolve(value) }
const waitOn = (list) => new Promise((resolve) => list.push(resolve))
const sameFacts = (a, b) => a.op === b.op && a.size === b.size && a.mtime === b.mtime && a.deep === b.deep

export function createPublishQueue({ order = 'fifo' } = {}) {
  let cmp = comparatorFor(order)
  let heap = createHeap((x, y) => cmp(x.item, y.item))
  const byKey = new Map()
  const perShare = new Map()
  let seq = 0
  let queued = 0
  let running = 0
  let queuedBytes = 0

  const bucket = (shareId) => {
    let b = perShare.get(shareId)
    if (!b) perShare.set(shareId, (b = { queued: 0, running: 0 }))
    return b
  }
  const live = (entry) => byKey.get(entry.item.key) === entry.item && entry.item.state === STATE.QUEUED && entry.gen === entry.item.gen
  const push = (item) => heap.push({ item, gen: item.gen })
  const admit = (item) => { queued += 1; queuedBytes += item.size; bucket(item.shareId).queued += 1 }
  const release = (item) => { queued -= 1; queuedBytes -= item.size; bucket(item.shareId).queued -= 1 }

  function enqueue(spec) {
    const key = itemKey(spec.shareId, spec.relPath)
    const cur = byKey.get(key)
    if (!cur) {
      const item = createItem(spec, seq++)
      byKey.set(key, item)
      admit(item)
      push(item)
      return { status: 'queued', settled: waitOn(item.waiters) }
    }
    const priority = Math.max(cur.priority, spec.priority ?? PRIORITY.BULK)
    const facts = factsOf(spec)
    if (cur.state === STATE.RUNNING) {
      cur.priority = priority
      // Identical facts (a catch-up diff re-finding a file mid-hash) join the run in flight; only
      // a change the running pass cannot have seen forces exactly one rerun.
      if (sameFacts(cur.next || cur, facts)) return { status: 'deduped', settled: waitOn(cur.dirty ? cur.nextWaiters : cur.waiters) }
      cur.dirty = true
      cur.next = facts
      return { status: 'superseded', settled: waitOn(cur.nextWaiters) }
    }
    queuedBytes += facts.size - cur.size
    Object.assign(cur, facts)
    cur.priority = priority
    cur.gen += 1
    push(cur)
    return { status: 'deduped', settled: waitOn(cur.waiters) }
  }

  function peek() {
    for (;;) {
      const entry = heap.peek()
      if (!entry) return null
      if (live(entry)) return entry.item
      heap.pop()
    }
  }

  function take() {
    for (;;) {
      const entry = heap.pop()
      if (!entry) return null
      if (!live(entry)) continue
      const item = entry.item
      item.state = STATE.RUNNING
      release(item)
      running += 1
      bucket(item.shareId).running += 1
      return item
    }
  }

  function settle(item, settlement) {
    if (item.state !== STATE.RUNNING) return item.state
    running -= 1
    bucket(item.shareId).running -= 1
    const waiters = item.waiters.splice(0)
    if (item.dirty && settlement.outcome !== 'cancelled') {
      Object.assign(item, item.next || {}, { state: STATE.QUEUED, dirty: false, next: null })
      item.waiters = item.nextWaiters.splice(0)
      item.gen += 1
      admit(item)
      push(item)
      resolveAll(waiters, settlement)
      return 'requeued'
    }
    item.state = settlement.outcome === 'failed' ? STATE.FAILED : settlement.outcome === 'cancelled' ? STATE.CANCELLED : STATE.DONE
    byKey.delete(item.key)
    resolveAll(waiters, settlement)
    resolveAll(item.nextWaiters, settlement)
    return item.state
  }

  function cancel(pred) {
    let n = 0
    for (const item of [...byKey.values()]) {
      if (!pred(item)) continue
      item.signal.aborted = true
      if (item.state === STATE.QUEUED) release(item)
      else { running -= 1; bucket(item.shareId).running -= 1 }
      item.state = STATE.CANCELLED
      item.dirty = false
      byKey.delete(item.key)
      resolveAll(item.waiters, { outcome: 'cancelled' })
      resolveAll(item.nextWaiters, { outcome: 'cancelled' })
      n += 1
    }
    return n
  }

  function setOrder(next) {
    cmp = comparatorFor(next)
    const kept = heap.drain().filter(live).map((e) => e.item)
    heap = createHeap((x, y) => cmp(x.item, y.item))
    for (const item of kept) push(item)
  }

  return {
    enqueue,
    peek,
    take,
    settle,
    cancel,
    setOrder,
    isPending(shareId, relPath) { return byKey.has(itemKey(shareId, relPath)) },
    pendingForShare(shareId) {
      const b = perShare.get(shareId)
      return b ? b.queued + b.running : 0
    },
    stats() { return { queued, running, queuedBytes } },
  }
}
