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

// The fields a later request for the same path may refresh. Never the scheduling fields.
export function factsOf(spec) {
  return { absPath: spec.absPath, size: spec.size ?? 0, mtime: spec.mtime ?? 0, op: spec.op, deep: !!spec.deep }
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
    waiters: [],
    nextWaiters: [],
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

export function comparatorFor(order) {
  const within = WITHIN[order] || WITHIN.fifo
  return (a, b) => (b.priority - a.priority) || (opCost(a) - opCost(b)) || within(a, b)
}
