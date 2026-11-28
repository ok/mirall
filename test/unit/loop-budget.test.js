import test from 'brittle'
import { createLoopBudget, yieldToLoop } from '../../src/shared/core/loop-budget.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// A clock the test moves, so no assertion here depends on how fast the machine is.
function clock() {
  let at = 1000
  return { now: () => at, advance: (ms) => { at += ms } }
}

test('a yield lets work already queued on the loop run first', async (t) => {
  let ran = false
  setImmediate(() => { ran = true })
  await yieldToLoop()
  t.ok(ran)
})

test('a due timer runs while a loop keeps yielding', async (t) => {
  let fired = false
  setTimeout(() => { fired = true }, 1)
  const started = Date.now()
  let yields = 0
  // Bounded by the clock only so a broken yield fails the test instead of hanging it.
  while (!fired && Date.now() - started < 2000) { await yieldToLoop(); yields += 1 }
  t.ok(fired, `the timer fired between yields (${yields} of them)`)
})

test('a budget is spent by elapsed time, not by how often it is asked', (t) => {
  const c = clock()
  const budget = createLoopBudget({ budgetMs: 8, now: c.now })
  let spentWhileStill = 0
  for (let i = 0; i < 1000; i++) if (budget.spent()) spentWhileStill += 1
  t.is(spentWhileStill, 0, 'asking a thousand times spends nothing while no time has passed')
  c.advance(7)
  t.absent(budget.spent(), 'inside the budget')
  c.advance(1)
  t.ok(budget.spent(), 'spent once the budget has elapsed')
})

test('ceding starts a fresh slice after the loop has had its turn', async (t) => {
  const c = clock()
  let cedes = 0
  // The time the loop spent on other work while ceded belongs to nobody's slice.
  const budget = createLoopBudget({ budgetMs: 8, now: c.now, cede: async () => { cedes += 1; c.advance(50) } })
  c.advance(8)
  t.ok(budget.spent())
  await budget.cede()
  t.is(cedes, 1)
  t.absent(budget.spent(), 'the slice starts when the loop hands the thread back')
  c.advance(8)
  t.ok(budget.spent())
})

// The reason the budget is time and not a count: the same loop with a tenfold cost per iteration
// must hold the thread no longer.
test('a loop cedes about once per budget whatever one iteration costs', async (t) => {
  for (const costMs of [1, 10]) {
    const c = clock()
    let cedes = 0
    let longestSlice = 0
    let sliceStart = c.now()
    const budget = createLoopBudget({ budgetMs: 8, now: c.now, cede: async () => { cedes += 1 } })
    for (let i = 0; i < 400 / costMs; i++) {
      if (budget.spent()) {
        longestSlice = Math.max(longestSlice, c.now() - sliceStart)
        await budget.cede()
        sliceStart = c.now()
      }
      c.advance(costMs)
    }
    t.ok(longestSlice <= 8 + costMs, `no slice runs past the budget by more than one iteration (${longestSlice} ms at ${costMs} ms each)`)
    t.ok(cedes >= 400 / (8 + costMs) - 1, `and the loop cedes throughout (${cedes} times)`)
  }
})

test('the default cede gives the event loop a turn', async (t) => {
  const budget = createLoopBudget({ budgetMs: 0 })
  let turns = 0
  for (let i = 0; i < 5; i++) {
    t.ok(budget.spent(), 'a zero budget is spent at every checkpoint')
    setImmediate(() => { turns += 1 })
    await budget.cede()
  }
  t.is(turns, 5, 'work queued on the loop ran at every cede')
})

test('the budget is the runtime-config value unless one is given', (t) => {
  const before = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(before))
  const c = clock()
  setRuntimeConfig({ ...before, loopYieldBudgetMs: 3 })
  const budget = createLoopBudget({ now: c.now })
  c.advance(2)
  t.absent(budget.spent())
  c.advance(1)
  t.ok(budget.spent())
})
