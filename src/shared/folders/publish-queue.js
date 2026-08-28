// One space's work queue: a heap in the configured order plus a byKey map that guarantees at
// most one live item per path. A second request for a path folds into the queued item, or marks
// a running one dirty for exactly one rerun — it can never start a second read of the file.
// Re-sorted and cancelled entries are dropped lazily: each push records the item's gen, and a
// popped entry whose gen no longer matches is skipped. An entry carries its OWN copy of the sort
// keys: the comparator must never read the mutable item, or a fold that raises a queued item's
// priority leaves its stale entry comparing equal to the new one and the heap order breaks.
import { OP, STATE, PRIORITY, itemKey, factsOf, createItem, comparatorFor, deferred, promiseOf, settleDeferred } from './work-item.js'

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
  }
}

const sameFacts = (a, b) => a.op === b.op && a.size === b.size && a.mtime === b.mtime && a.deep === b.deep

// `settled` and `exited` are read lazily off the run's shared deferreds (see work-item.js).
function ticket(status, run, exit) {
  return { status, get settled() { return promiseOf(run) }, get exited() { return promiseOf(exit) } }
}

export function createPublishQueue({ order = 'fifo' } = {}) {
  const cmp = comparatorFor(order)
  const heap = createHeap(cmp)
  const byKey = new Map()
  const perShare = new Map()
  let seq = 0
  let queued = 0
  let running = 0
  let queuedBytes = 0

  const bucket = (shareId) => {
    let b = perShare.get(shareId)
    if (!b) perShare.set(shareId, (b = { queued: 0, running: 0, queuedBytes: 0 }))
    return b
  }
  const live = (entry) => byKey.get(entry.item.key) === entry.item && entry.item.state === STATE.QUEUED && entry.gen === entry.item.gen
  const push = (item) => heap.push({ item, gen: item.gen, priority: item.priority, op: item.op, size: item.size, seq: item.seq })
  const admit = (item) => { queued += 1; queuedBytes += item.size; const b = bucket(item.shareId); b.queued += 1; b.queuedBytes += item.size }
  const release = (item) => { queued -= 1; queuedBytes -= item.size; const b = bucket(item.shareId); b.queued -= 1; b.queuedBytes -= item.size }

  function enqueue(spec) {
    const key = itemKey(spec.shareId, spec.relPath)
    const cur = byKey.get(key)
    if (!cur) {
      const item = createItem(spec, seq++)
      byKey.set(key, item)
      admit(item)
      push(item)
      return ticket('queued', item.run, item.exit)
    }
    const priority = Math.max(cur.priority, spec.priority ?? PRIORITY.BULK)
    const facts = factsOf(spec)
    if (cur.state === STATE.RUNNING) {
      cur.priority = priority
      // Identical facts (a catch-up diff re-finding a file mid-hash) join the run in flight; only
      // a change the running pass cannot have seen forces exactly one rerun. A cancelled run is
      // never joined — it is not going to finish the work.
      if (!cur.cancelled && sameFacts(cur.next || cur, facts)) return ticket('deduped', cur.dirty ? cur.rerun : cur.run, cur.exit)
      cur.dirty = true
      cur.next = facts
      return ticket('superseded', cur.rerun, cur.exit)
    }
    // A queued item takes the newest facts, except `deep`, which is sticky: it is the only pass
    // that settles a size-matching file by hash instead of re-advertising it.
    release(cur)
    Object.assign(cur, facts, { deep: cur.deep || facts.deep, priority })
    admit(cur)
    cur.gen += 1
    push(cur)
    return ticket('deduped', cur.run, cur.exit)
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

  // The executor returned: `exit` settles here in every case, so a caller that must write after
  // its tail (a direct unshare of the same path) has an event to wait on rather than a timer.
  function settle(item, settlement) {
    if (item.state !== STATE.RUNNING) return item.state
    running -= 1
    bucket(item.shareId).running -= 1
    const run = item.run
    const exit = item.exit
    if (item.dirty) {
      // The rerun is a fresh run: its own abort signal, its own exit, never the cancelled one.
      Object.assign(item, item.next || {}, { state: STATE.QUEUED, dirty: false, next: null, cancelled: false, signal: { aborted: false } })
      item.run = item.rerun
      item.rerun = deferred()
      item.exit = deferred()
      item.gen += 1
      admit(item)
      push(item)
      settleDeferred(run, settlement)
      settleDeferred(exit, settlement)
      return 'requeued'
    }
    item.state = item.cancelled ? STATE.CANCELLED : settlement.outcome === 'failed' ? STATE.FAILED : STATE.DONE
    byKey.delete(item.key)
    settleDeferred(run, settlement)
    settleDeferred(item.rerun, settlement)
    settleDeferred(exit, settlement)
    return item.state
  }

  // A queued item leaves at once (it never ran, so it has exited too). A RUNNING item is only
  // signalled: it stays the path's one live item — still counted as running, still pending for
  // the sweep's probe — until its executor returns, so a request arriving meanwhile supersedes it
  // into one rerun instead of starting a second executor whose tail the first one's revert would
  // then overwrite. Returns the items it cancelled.
  function cancel(pred) {
    const out = []
    for (const item of [...byKey.values()]) {
      if (!pred(item)) continue
      item.signal.aborted = true
      // A cancel discards a queued publish rerun — but never a queued RETIRE: that is disk state
      // (the file is gone), not work the user asked to stop, so it still runs after the abort.
      const keepRetire = item.next?.op === OP.RETIRE
      if (!keepRetire) {
        item.dirty = false
        item.next = null
      }
      const cancelled = { outcome: 'cancelled' }
      if (item.state === STATE.QUEUED) {
        release(item)
        item.state = STATE.CANCELLED
        byKey.delete(item.key)
        settleDeferred(item.exit, cancelled)
      } else {
        item.cancelled = true
      }
      settleDeferred(item.run, cancelled)
      if (!keepRetire) {
        // A request arriving after the cancel supersedes into a real rerun; it must not inherit
        // the settlement just handed to the callers the cancel released.
        settleDeferred(item.rerun, cancelled)
        item.rerun = deferred()
      }
      out.push(item)
    }
    return out
  }

  return {
    enqueue,
    peek,
    take,
    settle,
    cancel,
    isPending(shareId, relPath) { return byKey.has(itemKey(shareId, relPath)) },
    pendingRelPaths(shareId) {
      const out = []
      for (const item of byKey.values()) if (item.shareId === shareId) out.push(item.relPath)
      return out
    },
    pendingForShare(shareId) {
      const b = perShare.get(shareId)
      return b ? b.queued + b.running : 0
    },
    bytesForShare(shareId) { return perShare.get(shareId)?.queuedBytes ?? 0 },
    stats() { return { queued, running, queuedBytes } },
  }
}
