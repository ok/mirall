// Boot-time reclaim of local-bee history. A Hyperbee is append-only, so a record rewritten many times
// keeps every copy. Before any holder opens them, a bee whose history dwarfs its live data is
// rewritten in place under its own key: live entries are copied to a scratch core and verified, the
// bee is truncated, refilled from the scratch and verified again, and the scratch is purged. The key
// never changes, so every build that opens this store, older ones included, reads the same core.
//
// Between the truncate and the refilled bee's verification the scratch is the only complete copy.
// The state file names the bee for that window, and the store is flushed before and after it, so a
// crash or power loss leaves either an intact bee or a marker the next boot restores from before
// anything opens the bee. A restore that cannot complete fails the boot rather than let a holder
// open a partial bee; nothing else here does.
import b4a from 'b4a'
import { createLogger } from '../core/logger.js'
import { writeFileAtomic } from '../core/atomic-file.js'
import {
  LOCAL_BEE_NAMES, createLocalBee, createLocalBeeScratch, getStore, getStoragePath,
  hasLocalBeeCore, hasMasterSecret,
} from '../core/store.js'
import { clearAndPurgeCore } from './core-purge.js'
import {
  copyOverhead, liveScanLimit, needsMeasure, normalizeRewriteState, rewriteDue, rewriteSaves,
} from './local-bee-rules.js'

const moduleLog = createLogger('local-bee-rewrite')

// Frozen on-disk name: renaming it forgets an interrupted rewrite on every install.
export const REWRITE_STATE_FILE = '.local-bee-rewrite.json'

export const REWRITE_INCOMPLETE = 'REWRITE_INCOMPLETE'

const COPY_BATCH_ENTRIES = 500
const BINARY = { valueEncoding: 'binary' }

let refillFault = null

/** @internal fails the next refill after its truncate, once */
export function _failRefillForTests(err) {
  refillFault = err
}

export async function maintainLocalBees({ log = moduleLog } = {}) {
  const result = { compact: false, rewritten: [] }
  if (!hasMasterSecret()) return result
  const state = await openRewriteState(log)

  // Every interrupted rewrite is settled before any new one starts: the file holds one marker, and a
  // scratch key purged in this process is never reopened in it, so a settled bee waits a boot.
  const settled = new Set()
  for (const name of LOCAL_BEE_NAMES) {
    const outcome = await guarded(name, 'settle', log, () => settleInterruptedRewrite(name, state, log))
    if (outcome) {
      settled.add(name)
      result.compact = true
    }
  }
  for (const name of LOCAL_BEE_NAMES) {
    if (settled.has(name)) continue
    const outcome = await guarded(name, 'rewrite', log, () => rewriteIfDue(name, state, log))
    if (outcome?.purged) result.compact = true
    if (outcome?.freedBytes == null) continue
    result.rewritten.push({ name, freedBytes: outcome.freedBytes })
    log.info('rewrote local bee', name, '- freed about', outcome.freedBytes, 'bytes')
  }
  return result
}

async function guarded(name, step, log, run) {
  try {
    return await run()
  } catch (err) {
    if (err.code === REWRITE_INCOMPLETE) throw err
    log.warn('local bee', step, 'skipped:', name, '-', err.message)
    return null
  }
}

// True when it purged a scratch, after restoring the bee from it if the marker names this bee.
async function settleInterruptedRewrite(name, state, log) {
  const hasScratch = await hasLocalBeeCore(name, { scratch: true })
  const marker = state.current.restoring
  if (marker?.name === name) {
    if (hasScratch) await restoreFromScratch(marker)
    else log.error('local bee rewrite marker without its scratch, nothing to restore from:', name)
    await state.commit({ restoring: null })
    if (!hasScratch) return false
    await purgeScratch(name)
    log.warn('settled an interrupted rewrite of local bee', name)
    return true
  }
  if (!hasScratch) return false
  // Without a marker the scratch never became the only complete copy, or the bee was verified after
  // it: the bee is complete either way.
  await purgeScratch(name)
  return true
}

async function restoreFromScratch(marker) {
  const bee = createLocalBee(marker.name)
  const scratch = createLocalBeeScratch(marker.name)
  try {
    await bee.ready()
    await scratch.ready()
    // The bee's fork moves only with the truncate: an unmoved fork means the truncate never reached
    // the disk and the bee is intact.
    if (bee.core.fork === marker.fork) return
    if (scratch.core.length !== marker.scratchLength) {
      throw new Error(`the scratch holds ${scratch.core.length} blocks, the marker recorded ${marker.scratchLength}`)
    }
    await refillFrom(bee, scratch)
  } catch (err) {
    throw rewriteIncomplete(marker.name, err)
  } finally {
    await closeQuietly(scratch)
    await closeQuietly(bee)
  }
}

// Resolves to { freedBytes, purged }: freedBytes null when the bee was left alone, purged when a
// scratch was written and dropped, so the caller compacts.
async function rewriteIfDue(name, state, log) {
  if (!(await hasLocalBeeCore(name))) return null
  if (state.current.restoring) throw new Error('an interrupted rewrite is still marked')
  const bee = createLocalBee(name)
  try {
    await bee.ready()
    const coreBytes = bee.core.byteLength
    const prior = state.current.measured[name]
    if (!needsMeasure({ coreBytes, prior })) return null
    const liveBytes = await liveByteLength(bee, { stopAbove: liveScanLimit(coreBytes) })
    const verdict = { coreBytes, liveBytes, overhead: prior?.overhead ?? 1, at: Date.now() }
    if (!rewriteDue(verdict)) {
      await state.commit({ measured: { ...state.current.measured, [name]: verdict } })
      return null
    }
    log.info('rewriting local bee', name, '-', coreBytes, 'bytes stored,', liveBytes, 'live')
    let copy
    try {
      copy = await rewriteInPlace(name, bee, state)
    } catch (err) {
      if (err.code === REWRITE_INCOMPLETE) throw err
      log.warn('local bee rewrite failed:', name, '-', err.message)
      return { freedBytes: null, purged: true }
    }
    const measured = { coreBytes: bee.core.byteLength, liveBytes, overhead: copyOverhead({ copyBytes: copy.bytes, liveBytes }), at: Date.now() }
    await state.commit({ measured: { ...state.current.measured, [name]: measured } })
    return { freedBytes: copy.swapped ? coreBytes - bee.core.byteLength : null, purged: true }
  } finally {
    await closeQuietly(bee)
  }
}

// Exact below `stopAbove`; past it the scan stops and the answer is a lower bound.
async function liveByteLength(bee, { stopAbove }) {
  let bytes = 0
  for await (const { key, value } of bee.createReadStream({}, BINARY)) {
    bytes += b4a.byteLength(key) + value.byteLength
    if (bytes > stopAbove) break
  }
  return bytes
}

// Resolves to { swapped, bytes }: whether the bee now holds only its live entries, and the size of
// the copy, which is what a fresh bee of this data costs.
async function rewriteInPlace(name, bee, state) {
  const scratch = createLocalBeeScratch(name)
  let owned = false
  let authoritative = false
  try {
    await scratch.ready()
    // A scratch already holding data was missed by the settle step and may be the only complete copy.
    if (scratch.core.length > 0) throw new Error('rewrite scratch is not empty')
    owned = true
    await copyEntries(bee, scratch)
    await verifySameEntries(bee, scratch)
    const copy = { swapped: false, bytes: scratch.core.byteLength }
    if (!rewriteSaves({ fromBytes: bee.core.byteLength, toBytes: copy.bytes })) return copy
    await flushStore()
    await state.commit({ restoring: { name, fork: bee.core.fork, scratchLength: scratch.core.length } })
    authoritative = true
    await refillFrom(bee, scratch)
    await flushStore()
    authoritative = false
    // A failed unmark leaves a complete bee and its marker: the scratch is kept, and the next boot's
    // restore rewrites the same entries.
    owned = false
    await state.commit({ restoring: null })
    owned = true
    return { swapped: true, bytes: copy.bytes }
  } catch (err) {
    throw authoritative ? rewriteIncomplete(name, err) : err
  } finally {
    await closeQuietly(scratch)
    if (owned && !authoritative) await purgeScratch(name)
  }
}

// truncate(0) keeps the handle valid, where a purge-and-reopen would hit corestore's cached core.
async function refillFrom(bee, scratch) {
  await bee.core.truncate(0)
  if (refillFault) {
    const err = refillFault
    refillFault = null
    throw err
  }
  await copyEntries(scratch, bee)
  await verifySameEntries(scratch, bee)
}

function rewriteIncomplete(name, cause) {
  const err = new Error(`local bee ${name} is incomplete and its copy could not be restored: ${cause.message}`, { cause })
  err.code = REWRITE_INCOMPLETE
  return err
}

// Values are copied and compared as the stored bytes, never re-encoded.
async function copyEntries(from, to) {
  let batch = to.batch()
  let pending = 0
  for await (const { key, value } of from.createReadStream({}, BINARY)) {
    await batch.put(key, value, BINARY)
    if (++pending === COPY_BATCH_ENTRIES) {
      await batch.flush()
      batch = to.batch()
      pending = 0
    }
  }
  await batch.flush()
}

async function verifySameEntries(a, b) {
  const left = a.createReadStream({}, BINARY)[Symbol.asyncIterator]()
  const right = b.createReadStream({}, BINARY)[Symbol.asyncIterator]()
  try {
    for (let n = 0; ; n++) {
      const [x, y] = await Promise.all([left.next(), right.next()])
      if (x.done || y.done) {
        if (x.done !== y.done) throw new Error('entry count differs after ' + n + ' entries')
        return
      }
      if (x.value.key !== y.value.key || !b4a.equals(x.value.value, y.value.value)) {
        throw new Error('entry ' + n + ' differs')
      }
    }
  } finally {
    await left.return?.()
    await right.return?.()
  }
}

// Writes reach RocksDB unsynced; a flush puts them in synced table files before the next step
// depends on them.
function flushStore() {
  return getStore().storage.db.flush()
}

// The clear registers the blob garbage and the purge drops the core; the caller compacts.
async function purgeScratch(name) {
  if (!(await hasLocalBeeCore(name, { scratch: true }))) return
  const scratch = createLocalBeeScratch(name)
  try {
    await clearAndPurgeCore(getStore(), scratch.core)
  } finally {
    await closeQuietly(scratch)
  }
}

// The state as last written; `commit` writes a change and applies it in memory only once the file
// holds it, so a failed write never leaves memory ahead of the disk.
async function openRewriteState(log) {
  const path = (await import('bare-path')).default
  const file = path.join(getStoragePath(), REWRITE_STATE_FILE)
  const state = {
    current: await readRewriteState(file, log),
    async commit(patch) {
      const next = { ...state.current, ...patch }
      await writeFileAtomic(file, b4a.from(JSON.stringify(next)))
      state.current = next
    },
  }
  return state
}

async function readRewriteState(file, log) {
  const fs = (await import('bare-fs')).default
  try {
    return normalizeRewriteState(JSON.parse(b4a.toString(fs.readFileSync(file))))
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('rewrite state unreadable, starting empty:', err.message)
    return normalizeRewriteState(null)
  }
}

async function closeQuietly(bee) {
  try { await bee.close() } catch {}
}
