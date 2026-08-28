// The owner-side unit of file work. The PATH is the identity — never the content hash, which is
// an output of the work: using its presence as "is this done?" made "already being hashed by
// another pass" unrepresentable. Pure (no bare-* imports) so the policy unit-tests under Node.

export const OP = { PUBLISH: 'publish', RETIRE: 'retire' }
export const STATE = { QUEUED: 'queued', RUNNING: 'running', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled' }
// INTERACTIVE = the user just did this (a watcher event); BULK = a reconcile backfill.
export const PRIORITY = { BULK: 0, INTERACTIVE: 1 }

export const PUBLISH_ORDERS = ['fifo', 'smallest-first', 'largest-first']

export function itemKey(shareId, relPath) {
  return shareId + '\0' + relPath
}

// The fields a later request for the same path may refresh. Never the scheduling fields, and
// never a disk path: the executor resolves the path from the CURRENT mount at execution time.
export function factsOf(spec) {
  return { size: spec.size ?? 0, mtime: spec.mtime ?? 0, op: spec.op, deep: !!spec.deep }
}

// One settlement per run, shared by every caller that asked for it. The promise exists only once
// a caller reads it — a diff pass enqueues thousands of specs and reads none — and a read after
// the settlement still sees the value.
export function deferred() {
  return { promise: null, resolve: null, value: undefined, done: false }
}

export function promiseOf(d) {
  if (!d.promise) d.promise = d.done ? Promise.resolve(d.value) : new Promise((resolve) => { d.resolve = resolve })
  return d.promise
}

export function settleDeferred(d, value) {
  if (d.done) return
  d.done = true
  d.value = value
  d.resolve?.(value)
}

export function createItem(spec, seq) {
  return {
    key: itemKey(spec.shareId, spec.relPath),
    spaceId: spec.spaceId,
    shareId: spec.shareId,
    relPath: spec.relPath,
    ...factsOf(spec),
    priority: spec.priority ?? PRIORITY.BULK,
    seq,
    gen: 0,
    state: STATE.QUEUED,
    dirty: false,
    next: null,
    // Set by cancel() on a RUNNING item: the executor is still on it, and however it returns the
    // item settles as CANCELLED (unless a fresh request has since marked it dirty for a rerun).
    cancelled: false,
    // `run` settles with this run; `rerun` with the one a supersede has queued behind it; `exit`
    // once this run's executor has RETURNED (or at once for an item cancelled while queued) — a
    // cancel releases `run` immediately, so `exit` is what a caller that must write after the
    // executor's tail waits for.
    run: deferred(),
    rerun: deferred(),
    exit: deferred(),
    signal: { aborted: false },
  }
}

const bySeq = (a, b) => a.seq - b.seq
const WITHIN = {
  fifo: bySeq,
  'smallest-first': (a, b) => (a.size - b.size) || bySeq(a, b),
  'largest-first': (a, b) => (b.size - a.size) || bySeq(a, b),
}
// A retire is one stat plus one catalog write; it must not queue behind a multi-minute hash.
const opCost = (it) => (it.op === OP.RETIRE ? 0 : 1)

// Compares the scheduling fields only ({ priority, op, size, seq }). A heap entry snapshots them
// at push time, so re-sorting an item never disturbs the entries already in the heap.
export function comparatorFor(order) {
  const within = WITHIN[order] || WITHIN.fifo
  return (a, b) => (b.priority - a.priority) || (opCost(a) - opCost(b)) || within(a, b)
}
