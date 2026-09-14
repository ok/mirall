import test from 'brittle'
import { findCycles } from '../helpers/import-graph.js'

// The data layer's cycles are guarded by test/integration/import-time.test.js, which also proves
// each SCC member survives being imported first. Nothing covered the renderer, and its two
// historically-reported cycles are `import type` in one direction — erased before anything runs,
// so the runtime count is zero and must stay there.
test('RATCHET: the renderer has no runtime import cycles', (t) => {
  const cycles = findCycles(['src/renderer'])
  t.alike(cycles.map((c) => c.join(' -> ')), [], 'a renderer module imports itself through a cycle')
})
