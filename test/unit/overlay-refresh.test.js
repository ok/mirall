import test from 'brittle'
import { makeSharesRefresh } from '../../src/shared/transfer/backends/overlay/overlay-refresh.js'

function manualClock() {
  const pending = new Map()
  let nextId = 1
  return {
    schedule: (fn) => { const id = nextId++; pending.set(id, fn); return id },
    clear: (id) => { pending.delete(id) },
    runAll: () => { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn() },
    size: () => pending.size,
  }
}

function build () {
  const calls = []
  const clock = manualClock()
  const r = makeSharesRefresh((spaceId, shareId) => calls.push(`${spaceId}|${shareId}`), { schedule: clock.schedule, clear: clock.clear })
  return { calls, clock, r }
}

test('first touch emits immediately (leading edge)', (t) => {
  const { calls, r } = build()
  r.touch('space', 'share')
  t.alike(calls, ['space|share'])
})

test('a burst within one window collapses to one leading + one trailing', (t) => {
  const { calls, clock, r } = build()
  r.touch('s', 'x'); r.touch('s', 'x'); r.touch('s', 'x')
  t.is(calls.length, 1, 'only the leading emit so far')
  clock.runAll()
  t.is(calls.length, 2, 'one trailing emit after the window')
})

test('a single touch produces no redundant trailing emit', (t) => {
  const { calls, clock, r } = build()
  r.touch('s', 'x')
  clock.runAll()
  t.is(calls.length, 1, 'leading only — nothing was coalesced')
})

test('flush emits immediately and cancels the open window', (t) => {
  const { calls, clock, r } = build()
  r.touch('s', 'x')      // leading
  r.touch('s', 'x')      // coalesced → pending
  r.flush('s', 'x')      // immediate terminal emit + cancel
  t.is(calls.length, 2)
  clock.runAll()
  t.is(calls.length, 2, 'no trailing — flush cancelled the window')
  t.is(clock.size(), 0, 'no leaked timers')
})

test('after the window closes, the next touch leads again', (t) => {
  const { calls, clock, r } = build()
  r.touch('s', 'x')      // leading (1)
  r.touch('s', 'x')      // pending
  clock.runAll()         // trailing (2)
  r.touch('s', 'x')      // new window → leading (3)
  t.is(calls.length, 3)
})

test('keys are independent per (space, share)', (t) => {
  const { calls, r } = build()
  r.touch('s', 'a')
  r.touch('s', 'b')
  t.alike(calls, ['s|a', 's|b'], 'each share leads on its own')
})

test('reset clears pending timers (no later emit)', (t) => {
  const { calls, clock, r } = build()
  r.touch('s', 'x')      // leading + open window
  r.touch('s', 'x')      // pending
  r.reset()
  clock.runAll()
  t.is(calls.length, 1, 'reset dropped the trailing')
  t.is(clock.size(), 0)
})
