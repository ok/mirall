import test from 'brittle'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { keptRanges, clearableGaps } = require('../../src/main/update-cache-ranges.js')

test('kept ranges merge where blobs touch or overlap, and the gaps are everything else', (t) => {
  const kept = keptRanges([
    { blockOffset: 100, blockLength: 50 },
    { blockOffset: 140, blockLength: 20 },
    { blockOffset: 160, blockLength: 5 },
    { blockOffset: 0, blockLength: 0, mapBlocks: [7, 8] },
  ])
  t.alike(kept, [[7, 9], [100, 165]])
  t.alike(clearableGaps(kept, 200), [[0, 7], [9, 100], [165, 200]])
})

test('a block map keeps the old-version blocks it points at', (t) => {
  const kept = keptRanges([{ blockOffset: 500, blockLength: 10, mapBlocks: [3, 250] }])
  t.alike(clearableGaps(kept, 510), [[0, 3], [4, 250], [251, 500]])
})

test('nothing kept clears the whole core; a core no longer than what is kept clears nothing', (t) => {
  t.alike(clearableGaps(keptRanges([]), 12), [[0, 12]])
  t.alike(clearableGaps(keptRanges([{ blockOffset: 0, blockLength: 12 }]), 12), [])
  t.alike(clearableGaps(keptRanges([{ blockOffset: 4, blockLength: 20 }]), 10), [[0, 4]], 'a kept range past the end stops the walk')
})
