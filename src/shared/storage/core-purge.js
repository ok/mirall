// The RocksDB core-purge primitives: delete a core's storage, or the alias that names it.
// Every caller that reclaims on-disk bytes for a catalog or a leftover core goes
// through here, so the tombstone-writing rules below are stated once.
import b4a from 'b4a'
import keysMod from 'hypercore-storage/lib/keys.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('core-purge')
const { store: keysStore, core: keysCore } = keysMod

// Deletes the core's alias (TL_CORE_BY_DKEY), TL_CORE range, and TL_DATA
// range. hypercore-storage's built-in deleteCore short-circuits when auth
// is missing, which leaves zombie aliases behind and crashes later opens
// with unslab / STORAGE_EMPTY. Writing the deletions directly avoids that.
export async function purgeCoreDk(cs, dkHex) {
  const dkBuf = b4a.from(dkHex, 'hex')
  const storage = await cs.storage.resumeCore(dkBuf)
  if (!storage) return
  const { corePointer, dataPointer } = storage.core
  try {
    const tx = cs.storage.db.write({ autoDestroy: true })
    tx.tryDelete(keysStore.core(dkBuf))
    tx.tryDeleteRange(keysCore.core(corePointer), keysCore.core(corePointer + 1))
    tx.tryDeleteRange(keysCore.data(dataPointer), keysCore.data(dataPointer + 1))
    await tx.flush()
  } finally {
    try { await storage.close() } catch {}
  }
  log.info('deleted core, dk:', dkHex.slice(0, 12))
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
