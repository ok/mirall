import { ownCatalog, fileKey } from './share-catalog.js'
import { getRuntimeConfig } from '../core/runtime-config.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('catalog-writer')

// Buffers catalog writes during a folder scan and commits them in one Hyperbee
// batch per flush, so the catalog core advances in fewer, atomic heads (a peer
// never reads a half-written group). Flushes on whichever comes first: flushMs
// elapsed or maxOps buffered. Ops on the same key coalesce (advertise+setHash →
// one write). Method signatures mirror share-catalog so it drops into publishContent
// via the `catalog` option; the per-op value shape and merge guards mirror
// share-catalog.advertise/setMaterializedHash/tombstone.
export function createCatalogBatch(spaceId, {
  flushMs = getRuntimeConfig().catalogFlushMs,
  maxOps = getRuntimeConfig().catalogFlushMaxOps,
  schedule = setTimeout,
  clear = clearTimeout,
  resolveBee = () => ownCatalog(spaceId),
} = {}) {
  let buffer = new Map()
  // Ops handed to a flush that has not landed yet. Read-your-writes (get) consults it, so a
  // publish never re-hashes a file whose materialized hash is mid-flush.
  let inflight = new Map()
  let timer = null
  let flushing = Promise.resolve()
  let closed = false

  const arm = () => {
    if (timer !== null || buffer.size === 0) return
    timer = schedule(() => { timer = null; void flush() }, flushMs)
    timer?.unref?.()
  }

  const stage = (key, op) => {
    if (closed) throw new Error('catalog batch is closed')
    const cur = buffer.get(key)
    if (op.kind === 'setHash' && cur?.kind === 'put') {
      buffer.set(key, { kind: 'put', value: { ...cur.value, contentHash: op.contentHash } })
    } else {
      buffer.set(key, op)
    }
    if (buffer.size >= maxOps) void flush()
    else arm()
  }

  function flush() {
    if (timer !== null) { clear(timer); timer = null }
    if (buffer.size === 0) return flushing
    const pending = buffer
    buffer = new Map()
    // Chain via .then (single-flight) but NEVER re-throw: a flush is best-effort — the scan
    // driving it must survive a failed write. Re-throwing would poison `flushing` (every later
    // flush/close would reject and silently drop its ops), surface as an unhandled rejection on
    // the void-flush paths, and abort the whole scan. Log and continue; dropped ops self-heal
    // on the next full scan.
    flushing = flushing.then(async () => {
      inflight = pending
      const bee = await resolveBee()
      const batch = bee.batch()
      try {
        for (const [key, op] of pending) {
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
        log.warn('catalog batch flush dropped ' + pending.size + ' op(s):', err.message)
      } finally {
        if (inflight === pending) inflight = new Map()
      }
    })
    return flushing
  }

  return {
    async advertise(_spaceId, shareId, relPath, { size, mtime, contentHash = null }) {
      stage(fileKey(shareId, relPath), { kind: 'put', value: { size, mtime, contentHash } })
    },
    async setMaterializedHash(_spaceId, shareId, relPath, contentHash) {
      stage(fileKey(shareId, relPath), { kind: 'setHash', contentHash })
    },
    async tombstone(_spaceId, shareId, relPath) {
      stage(fileKey(shareId, relPath), { kind: 'tombstone' })
    },
    // What a reader of THIS batch sees for a path: staged and in-flight ops over the bee.
    async get(_spaceId, shareId, relPath) {
      const key = fileKey(shareId, relPath)
      const op = buffer.get(key) ?? inflight.get(key)
      if (op?.kind === 'tombstone') return null
      if (op?.kind === 'put') return { relPath, size: op.value.size, mtime: op.value.mtime, contentHash: op.value.contentHash ?? null }
      const bee = await resolveBee()
      const node = await bee.get(key)
      if (!node?.value || node.value.deletedAt) return null
      const base = { relPath, size: node.value.size, mtime: node.value.mtime, contentHash: node.value.contentHash ?? null }
      return op?.kind === 'setHash' ? { ...base, contentHash: op.contentHash } : base
    },
    flush,
    async close() { closed = true; await flush() },
  }
}
