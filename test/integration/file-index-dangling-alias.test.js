import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { getStore, initStore } from '../../src/shared/core/store.js'
import { purgeCoreDk } from '../../src/shared/spaces/space.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'

// REGRESSION (FIX-150: the old leftover "Clean up" purged the file-index core via
// purgeCoreDk, which deletes the data + by-discovery-key alias but NOT the by-name
// alias — leaving 'file-index' dangling. On the next boot, opening it by name threw
// STORAGE_EMPTY and blocked the whole profile from starting).
test('FileIndex recovers from a dangling index alias by advancing the version', async (t) => {
  const ctx = await freshPeer(t)

  const fi1 = new FileIndex(getStore().namespace('recover-fi'))
  await fi1.ready()
  await fi1.putChunkMapByHash('cafe', [{ hash: 'h', offset: 0, length: 1 }])
  t.is(fi1._version, 1, 'starts at v1 (core name "file-index")')
  const dk = b4a.toString(fi1.bee.core.discoveryKey, 'hex')
  await fi1.close()

  // Reproduce the purge: delete the core + its by-dkey alias, leaving the by-name alias.
  await purgeCoreDk(getStore(), getStore().storage.db, dk)
  await getStore().storage.db.flush()

  // Simulate a real boot — reopen the store so nothing is cached in memory.
  await getStore().close()
  initStore(ctx.storage)
  await getStore().ready()

  const fi2 = new FileIndex(getStore().namespace('recover-fi'))
  await fi2.ready() // must NOT throw STORAGE_EMPTY
  t.ok(fi2._version > 1, 'advanced past the dangling version rather than failing boot')
  t.absent(await fi2.hasChunkMapByHash('cafe'), 'the recovered index is fresh (stale cache gone)')
  await fi2.putChunkMapByHash('beef', [{ hash: 'h', offset: 0, length: 1 }])
  t.ok(await fi2.hasChunkMapByHash('beef'), 'the recovered index is writable')
  await fi2.close()
})
