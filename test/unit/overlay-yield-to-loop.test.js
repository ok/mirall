import test from 'brittle'
import { yieldToLoop } from '../../src/shared/transfer/backends/overlay/engine/yield-to-loop.js'

test('a yield lets a queued macrotask run first', async (t) => {
  let ran = false
  setTimeout(() => { ran = true }, 0)
  await yieldToLoop()
  t.ok(ran)
})
