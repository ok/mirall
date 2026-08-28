import { ownCatalog, fileKey, classifyEntryNode } from './share-catalog.js'
import { getRuntimeConfig } from '../core/runtime-config.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('catalog-writer')

// Buffers catalog writes during a folder scan and commits them in one Hyperbee
// batch per flush, so the catalog core advances in fewer, atomic heads (a peer
// never reads a half-written group). Flushes on whichever comes first: flushMs
// elapsed or maxOps buffered. Ops on the same key coalesce (advertise+setHash →
// one write). Method signatures mirror share-catalog so it drops into publishContent
// via the `catalog` option; the per-op value shape and merge guards mirror
// share-catalog.advertise/setMaterializedHash/tombstone. Each write resolves to
// `{ landed }` — a promise for the flush that carries it — so a caller that must act only
// once the write is durable (drop a serve reference after its tombstone) can wait for
// exactly that, without awaiting the flush inline.
export function createCatalogBatch(spaceId, {
  flushMs = getRuntimeConfig().catalogFlushMs,
  maxOps = getRuntimeConfig().catalogFlushMaxOps,
  schedule = setTimeout,
  clear = clearTimeout,
  resolveBee = () => ownCatalog(spaceId),
} = {}) {
  // A generation is one flush's worth of ops: the one still being staged into, then every one
  // handed to a flush that has not landed yet (oldest first). Read-your-writes (get) folds all of
  // them over the bee, so a publish never re-hashes a file whose materialized hash is mid-flush
  // — whether that flush is running or queued behind another.
  const newGen = () => { const g = { ops: new Map(), landed: null, land: null }; g.landed = new Promise((r) => { g.land = r }); return g }
  let cur = newGen()
  const inflight = []
  let timer = null
  let flushing = Promise.resolve()
  let closed = false

  const arm = () => {
    if (timer !== null || cur.ops.size === 0) return
    timer = schedule(() => { timer = null; void flush() }, flushMs)
    timer?.unref?.()
  }

  const stage = (key, op) => {
    if (closed) throw new Error('catalog batch is closed')
    const gen = cur
    const prev = gen.ops.get(key)
    if (op.kind === 'setHash' && prev?.kind === 'put') {
      gen.ops.set(key, { kind: 'put', value: { ...prev.value, contentHash: op.contentHash } })
    } else {
      gen.ops.set(key, op)
    }
    if (gen.ops.size >= maxOps) void flush()
    else arm()
    return gen.landed
  }

  function flush() {
    if (timer !== null) { clear(timer); timer = null }
    if (cur.ops.size === 0) return flushing
    const gen = cur
    cur = newGen()
    inflight.push(gen)
    // Chain via .then (single-flight) but NEVER re-throw: a flush is best-effort — the scan
    // driving it must survive a failed write. Re-throwing would poison `flushing` (every later
    // flush/close would reject and silently drop its ops), surface as an unhandled rejection on
    // the void-flush paths, and abort the whole scan. Log and continue; dropped ops self-heal
    // on the next full scan.
    flushing = flushing.then(async () => {
      const bee = await resolveBee()
      const batch = bee.batch()
      try {
        for (const [key, op] of gen.ops) {
          if (op.kind === 'put') { await batch.put(key, op.value); continue }
          const node = await batch.get(key)
          if (!node?.value) continue
          if (op.kind === 'setHash') {
            if (!node.value.deletedAt && node.value.contentHash !== op.contentHash) {
              await batch.put(key, { ...node.value, contentHash: op.contentHash })
            }
          } else {
            await batch.put(key, { ...node.value, deletedAt: Date.now() })
          }
        }
        await batch.flush()
      } catch (err) {
        try { await batch.close?.() } catch {}
        log.warn('catalog batch flush dropped ' + gen.ops.size + ' op(s):', err.message)
      } finally {
        inflight.splice(inflight.indexOf(gen), 1)
        gen.land()
      }
    })
    return flushing
  }

  const fromValue = (relPath, v) => ({ relPath, size: v.size, mtime: v.mtime, contentHash: v.contentHash ?? null })

  return {
    async advertise(_spaceId, shareId, relPath, { size, mtime, contentHash = null }) {
      return { landed: stage(fileKey(shareId, relPath), { kind: 'put', value: { size, mtime, contentHash } }) }
    },
    async setMaterializedHash(_spaceId, shareId, relPath, contentHash) {
      return { landed: stage(fileKey(shareId, relPath), { kind: 'setHash', contentHash }) }
    },
    async tombstone(_spaceId, shareId, relPath) {
      return { landed: stage(fileKey(shareId, relPath), { kind: 'tombstone' }) }
    },
    // What a reader of THIS batch sees for a path: every un-landed op for it, oldest first,
    // applied over the bee. The bee is consulted only when the oldest op needs a base (setHash).
    async get(_spaceId, shareId, relPath) {
      const key = fileKey(shareId, relPath)
      const ops = []
      for (const gen of inflight) { const op = gen.ops.get(key); if (op) ops.push(op) }
      const staged = cur.ops.get(key)
      if (staged) ops.push(staged)
      let entry = null
      if (!ops.length || ops[0].kind === 'setHash') {
        const bee = await resolveBee()
        const state = classifyEntryNode(await bee.get(key))
        entry = state && !state.removed ? fromValue(relPath, state) : null
      }
      for (const op of ops) {
        if (op.kind === 'put') entry = fromValue(relPath, op.value)
        else if (op.kind === 'tombstone') entry = null
        else if (entry) entry = { ...entry, contentHash: op.contentHash }
      }
      return entry
    },
    flush,
    async close() { closed = true; await flush() },
  }
}
