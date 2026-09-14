import { scaled } from './bare-timing.js'

// One poll for the Bare suite. Two shapes because both are in use and both are right: until()
// returns false on timeout, for a test asserting a state never arrives; waitFor() throws, for a
// precondition, where a false return becomes a confusing downstream assertion instead of a clear
// "never happened".
//
// `interval` is the caller's: a 10ms poll on a CPU-bound convergence test is pure contention, and a
// 100ms poll on a fast latch wastes wall clock. `scale` is off only where a deadline must stay
// absolute because the behaviour races an un-scaled production constant.
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
