import test from 'brittle'
import { tmpStore } from './overlay-engine-helpers.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/engine/file-index.js'

const MAP = [{ hash: 'h', offset: 0, length: 1 }]

async function openIndex(t, label) {
  const index = new FileIndex(tmpStore(label))
  await index.ready()
  t.teardown(() => index.close())
  return index
}

test('compact() keeps served content-addressed maps and drops every other row', async (t) => {
  const index = await openIndex(t, 'ck')
  const S = 'aa'.repeat(32)
  const U = 'bb'.repeat(32)
  await index.putChunkMapByHash(S, MAP)
  await index.putChunkMapByHash(U, MAP)
  const legacy = ['file:/mir/' + S, 'chunkmap:/mir/' + S, 'chunkmap:content:' + S, 'chunkmap:/real/path.bin',
    'file:/real/path.bin', 'sync:' + '34'.repeat(32) + ':/x', 'config:sync', 'tree:' + S, 'treepath:/x']
  for (const key of legacy) await index.bee.put(key, { legacy: true })

  const old = await index.compact({ isServed: (h) => h === S })
  t.ok(old, 'a pass ran')
  const keys = []
  for await (const { key } of index.bee.createReadStream()) keys.push(key)
  t.alike(keys, ['chunkmap-oid:' + S], 'only the served map survives')
  t.alike(await index.getChunkMapByHash(S), MAP, 'and it still reads back')
  t.is(await index.compact({ isServed: (h) => h === S }), null, 'a clean index is left untouched')
})

test('a paged map of a served hash keeps every page', async (t) => {
  const index = await openIndex(t, 'ck-paged')
  const S = 'cc'.repeat(32)
  const big = Array.from({ length: 40000 }, (_, i) => ({ hash: 'h' + i, offset: i, length: 1 }))
  await index.putChunkMapByHash(S, big)
  await index.bee.put('file:/mir/' + S, { legacy: true })
  t.ok(await index.compact({ isServed: (h) => h === S }), 'the legacy row made it compactable')
  t.is((await index.getChunkMapByHash(S)).length, big.length, 'the paged map survived whole')
})

test('an identical re-put appends nothing', async (t) => {
  const index = await openIndex(t, 'dup')
  await index.putChunkMapByHash('dd'.repeat(32), MAP)
  const len = index.bee.core.length
  await index.putChunkMapByHash('dd'.repeat(32), MAP)
  t.is(index.bee.core.length, len)
})
