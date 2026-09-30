// On-disk bytes of chosen cores, keyed by discovery key: the store's range estimate over the same header
// and data ranges purgeCoreDk deletes. No block is read, so a sparse peer core counts what this
// device holds, not the remote's logical length. Values the store separates into blob files (4 KB
// and up) are outside the estimate, so this suits cores of small blocks, like a catalog.
import b4a from 'b4a'
import keysMod from 'hypercore-storage/lib/keys.js'

const { core: keysCore } = keysMod
const ESTIMATE = { includeMemtables: true }

// Only the cores in `dks` are estimated: the stream reads each core's pointers, not its blocks,
// and the rest of the store is left to the caller's remainder.
/** @param {Set<string>} dks @returns {Promise<Map<string, number>>} */
export async function measureCoreBytes(cs, dks) {
  const { db } = cs.storage
  const bytes = new Map()
  for await (const { discoveryKey, core } of cs.storage.createCoreStream()) {
    const dk = b4a.toString(discoveryKey, 'hex')
    if (!dks.has(dk)) continue
    const [header, data] = await Promise.all([
      db.approximateSize(keysCore.core(core.corePointer), keysCore.core(core.corePointer + 1), ESTIMATE),
      db.approximateSize(keysCore.data(core.dataPointer), keysCore.data(core.dataPointer + 1), ESTIMATE),
    ])
    bytes.set(dk, header + data)
  }
  return bytes
}
