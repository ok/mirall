// Chronological journals kept in `reclaim-meta`: the sweep journal and the removal evidence. Keys are
// <prefix><at, 16 digits>-<seq, 4 digits>, zero-padded so the bee's order is chronological and
// counter-suffixed so two entries inside one millisecond cannot collide. Reads and writes never
// throw: each journal is a record beside the work, and must not be the thing that fails it. Every
// writer of `reclaim-meta` opens it through reclaimMetaBee, so their writes take turns.
import { createLocalBee } from '../core/store.js'
import { prefixRange } from '../core/bee-keys.js'
import { errorMessage } from '../core/errors.js'

let seq = 0
let lock

export function reclaimMetaBee() {
  const bee = createLocalBee('reclaim-meta', { lock })
  lock ??= bee.lock
  return bee
}

export const journalKey = (prefix, at) => prefix + String(at).padStart(16, '0') + '-' + String(seq++).padStart(4, '0')

export async function withReclaimMeta(fn, { log, failure, fallback }) {
  let bee = null
  try {
    bee = reclaimMetaBee()
    await bee.ready()
    return await fn(bee)
  } catch (err) {
    log.warn(failure, errorMessage(err))
    return fallback
  } finally {
    try { await bee?.close() } catch {}
  }
}

export async function readJournal(bee, prefix, { reverse = false, limit = Infinity } = {}) {
  const out = []
  for await (const node of bee.createReadStream({ ...prefixRange(prefix), reverse })) {
    out.push(node)
    if (out.length >= limit) break
  }
  return out
}
