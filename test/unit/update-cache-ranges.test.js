import test from 'brittle'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { keptRanges, clearableGaps, keptBytes } = require('../../src/main/update-cache-ranges.js')

test('kept ranges merge where blobs touch or overlap, and the gaps are everything else', (t) => {
  const kept = keptRanges([
    { blockOffset: 100, blockLength: 50 },
    { blockOffset: 140, blockLength: 20 },
    { blockOffset: 160, blockLength: 5 },
    { blockOffset: 0, blockLength: 0, mapBlocks: [{ index: 7, byteLength: 1 }, { index: 8, byteLength: 1 }] },
  ])
  t.alike(kept, [[7, 9], [100, 165]])
  t.alike(clearableGaps(kept, 200), [[0, 7], [9, 100], [165, 200]])
})

test('a block map keeps the old-version blocks it points at', (t) => {
  const kept = keptRanges([{ blockOffset: 500, blockLength: 10, mapBlocks: [{ index: 3, byteLength: 1 }, { index: 250, byteLength: 1 }] }])
  t.alike(clearableGaps(kept, 510), [[0, 3], [4, 250], [251, 500]])
})

test('nothing kept clears the whole core; a core no longer than what is kept clears nothing', (t) => {
  t.alike(clearableGaps(keptRanges([]), 12), [[0, 12]])
  t.alike(clearableGaps(keptRanges([{ blockOffset: 0, blockLength: 12 }]), 12), [])
  t.alike(clearableGaps(keptRanges([{ blockOffset: 4, blockLength: 20 }]), 10), [[0, 4]], 'a kept range past the end stops the walk')
})

test('REGRESSION (update cache estimate): kept bytes count a mapped block by its own size, once', (t) => {
  t.is(keptBytes([
    { blockOffset: 500, blockLength: 1, byteLength: 8, mapBlocks: [{ index: 3, byteLength: 1000 }, { index: 4, byteLength: 700 }] },
    { blockOffset: 501, blockLength: 1, byteLength: 6, mapBlocks: [{ index: 4, byteLength: 700 }] },
  ]), 8 + 6 + 1000 + 700, 'the maps plus every block they point at, a shared block counted once')
  t.is(keptBytes([
    { blockOffset: 10, blockLength: 5, byteLength: 5000 },
    { blockOffset: 10, blockLength: 5, byteLength: 5000 },
    { blockOffset: 10, blockLength: 0, byteLength: 0 },
    { blockOffset: 20, blockLength: 1, byteLength: 4, mapBlocks: [{ index: 12, byteLength: 1000 }] },
  ]), 5000 + 4, 'a blob shared by two files counts once, an empty one adds nothing, and a mapped block inside a blob is that blob\'s')
})
