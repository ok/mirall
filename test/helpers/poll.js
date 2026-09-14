import { scaled } from './timing.js'

// The Node twin of bare-poll.js, for test/unit, test/flow and test/raw. Same contract as there —
// the only difference is where the scale factor comes from.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function until(fn, ms = 10000, { interval = 50, scale = true } = {}) {
  const deadline = Date.now() + (scale ? scaled(ms) : ms)
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(interval)
  }
  // One check after the deadline: a condition that flips during the final sleep was never looked
  // at, and three of the call sites this replaced re-checked for exactly that reason.
  return !!(await fn())
}

export async function waitFor(fn, ms = 10000, { interval = 50, scale = true, label = 'condition' } = {}) {
  if (await until(fn, ms, { interval, scale })) return true
  throw new Error(`timed out waiting for ${label} (${scale ? scaled(ms) : ms}ms)`)
}
