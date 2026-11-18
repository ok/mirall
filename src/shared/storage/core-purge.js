// The RocksDB core-purge primitives: delete a core's storage, or the alias that names it.
// Every caller that reclaims on-disk bytes for a catalog or a leftover core goes
// through here, so the tombstone-writing rules below are stated once.
import b4a from 'b4a'
import keysMod from 'hypercore-storage/lib/keys.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('core-purge')
const { store: keysStore, core: keysCore } = keysMod

// The in-memory core corestore hands every later get() of this discovery key, or null. Deleting
// the rows under it leaves a core whose bitfield claims blocks that are gone: its reads stall until
// the process restarts.
function openCore(cs, dkHex) {
  return cs.cores.get(dkHex)
}

// Deletes a core's storage and reports whether it did. A core this process holds open is never
// deleted under its holder: corestore's own purge refuses one with a live session (kept, false),
// and closes an idle one, replication included, before deleting it. A kept core is a leftover for
// the boot sweep (cleanupOrphanedData). A core that is not open has its alias (TL_CORE_BY_DKEY),
// TL_CORE range and TL_DATA range deleted directly: hypercore-storage's built-in deleteCore
// short-circuits when auth is missing, which leaves zombie aliases behind and crashes later opens
// with unslab / STORAGE_EMPTY.
export async function purgeCoreDk(cs, dkHex) {
  const dkBuf = b4a.from(dkHex, 'hex')
  if (openCore(cs, dkHex)) return purgeOpenCore(cs, dkBuf, dkHex)
  const storage = await cs.storage.resumeCore(dkBuf)
  if (!storage) return false
  const { corePointer, dataPointer } = storage.core
  try {
    if (openCore(cs, dkHex)) return purgeOpenCore(cs, dkBuf, dkHex)
    const tx = cs.storage.db.write({ autoDestroy: true })
    tx.tryDelete(keysStore.core(dkBuf))
    tx.tryDeleteRange(keysCore.core(corePointer), keysCore.core(corePointer + 1))
    tx.tryDeleteRange(keysCore.data(dataPointer), keysCore.data(dataPointer + 1))
    await tx.flush()
  } finally {
    try { await storage.close() } catch {}
  }
  log.info('deleted core, dk:', dkHex.slice(0, 12))
  return true
}

async function purgeOpenCore(cs, dkBuf, dkHex) {
  const purged = await cs.purge({ discoveryKey: dkBuf })
  if (purged.length === 0) {
    log.warn('kept a core still open in this process, dk:', dkHex.slice(0, 12))
    return false
  }
  log.info('closed and deleted core, dk:', dkHex.slice(0, 12))
  return true
}

// Reclaim a writable core's on-disk bytes: clear its blocks (which registers
// RocksDB blob-file garbage) then delete the header/alias. A bare purgeCoreDk
// range-delete leaves blob-separated values stranded — no compaction frees them
// (garbage stays 0); the clear is what makes them reclaimable. Caller compacts.
export async function clearAndPurgeCore(cs, core) {
  await core.ready()
  try { await core.clear(0, core.length) } catch (err) { log.warn('core.clear before purge failed:', err.message) }
  const dkHex = b4a.toString(core.discoveryKey, 'hex')
  try { await core.close() } catch {}
  await purgeCoreDk(cs, dkHex)
}

// Removes the TL_CORE_BY_ALIAS entry that maps a (namespace, name) pair to
// a discovery key. Required when purging a named core: corestore.get({ name })
// resolves the alias first; without this, a same-name reopen after purge
// returns the old discovery key and throws STORAGE_EMPTY because the core
// itself was deleted.
export async function purgeAlias(cs, namespace, name) {
  if (!namespace || !name) return
  const aliasKey = keysStore.coreByAlias({ namespace, name })
  const tx = cs.storage.db.write({ autoDestroy: true })
  tx.tryDelete(aliasKey)
  await tx.flush()
  log.info('deleted alias:', name)
}

// Purge a core by its (namespace, name), resolving the alias first rather than opening the name
// blind: a name that was never written needs nothing, and a name whose core an earlier purge
// deleted, alias left behind, is finished by dropping the alias instead of failing the open with
// STORAGE_EMPTY (see purgeAlias). A core that is there is cleared and purged whole, and its open
// failing propagates. `ns` is the namespaced corestore the name lives in.
export async function purgeNamedCore(cs, ns, name) {
  const dk = await cs.storage.getAlias({ name, namespace: ns.ns })
  if (!dk) return
  if (await cs.storage.hasCore(dk)) {
    const core = ns.get({ name, valueEncoding: 'binary' })
    await core.ready()
    await clearAndPurgeCore(cs, core)
  }
  await purgeAlias(cs, ns.ns, name)
}
