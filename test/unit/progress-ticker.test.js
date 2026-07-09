import test from 'brittle'
import { makeProgressTicker } from '../../src/shared/transfer/progress-ticker.js'

// The ticker is the shared engine behind both the single-file download bar
// (transfers.js) and the folder-mirror per-file bar (foreign-folders.js). Drive
// an injected clock so emit cadence and byte accounting are deterministic.

test('first push always emits; subsequent pushes are throttled to the interval', (t) => {
  let clock = 0
  const emits = []
  const ticker = makeProgressTicker(400, (p) => emits.push(p), { now: () => clock })

  clock = 251; ticker.push(100) // 251 - 0 > 250 → emit #0
  clock = 300; ticker.push(100) // +49ms → throttled
  clock = 400; ticker.push(100) // +149ms → throttled
  clock = 600; ticker.push(100) // 600 - 251 = 349ms > 250 → emit #1

  t.is(emits.length, 2, 'exactly two emits across four pushes')
  t.is(emits[0].bytes, 100, 'first emit carries the first chunk')
  t.is(emits[1].bytes, 400, 'second emit carries all bytes so far')
  t.is(emits[0].total, 400, 'total is carried through')
  t.is(emits[1].total, 400, 'total is stable')
  t.is(ticker.transferred, 400, 'transferred tracks every pushed byte')
})

test('bytes are monotonic non-decreasing and speed/eta are finite & non-negative', (t) => {
  let clock = 1000
  const emits = []
  const ticker = makeProgressTicker(1000, (p) => emits.push(p), { now: () => clock })

  for (let i = 0; i < 10; i++) {
    clock += 300 // each push clears the 250ms gate
    ticker.push(100)
  }

  t.is(emits.length, 10, 'one emit per spaced push')
  t.is(ticker.transferred, 1000, 'all bytes accounted')
  let prev = 0
  for (const e of emits) {
    t.ok(e.bytes >= prev, 'bytes never decrease')
    t.ok(Number.isFinite(e.speed) && e.speed >= 0, 'speed is finite & non-negative')
    t.ok(e.eta === null || (Number.isFinite(e.eta) && e.eta >= 0), 'eta is null (warmup) or finite & non-negative')
    prev = e.bytes
  }
  t.is(emits[emits.length - 1].bytes, 1000, 'final emit reaches total')
})

test('eta starts null during warmup, then settles to a positive number', (t) => {
  let clock = 0
  const emits = []
  // 2 GB total → medium profile (warmup 2.5s). Steady 100 MB/s stream.
  const total = 2 * 1024 * 1024 * 1024
  const step = 25 * 1024 * 1024 // 25 MB per 250ms tick = 100 MB/s
  const ticker = makeProgressTicker(total, (p) => emits.push(p), { now: () => clock })

  for (let i = 0; i < 60; i++) {
    clock += 300
    ticker.push(step)
  }

  t.is(emits[0].eta, null, 'first emit is still estimating')
  const settled = emits[emits.length - 1]
  t.ok(settled.eta != null && settled.eta > 0, 'eta resolves to a positive estimate once warm')
  t.ok(settled.speed > 0, 'speed reports the smoothed rate')
})

test('pushTo reports the cumulative bytes it is given (overlay scheduler is resume-seeded)', (t) => {
  let clock = 0
  const emits = []
  const ticker = makeProgressTicker(1000, (p) => emits.push(p), { now: () => clock })
  clock = 300; ticker.pushTo(400) // scheduler resumes already holding 400 bytes
  t.is(emits[0].bytes, 400, 'first emit reflects the resumed cumulative, not double-counted')
  clock = 600; ticker.pushTo(450)
  t.is(emits[1].bytes, 450, 'subsequent cumulative reports pass through unchanged')
  t.is(ticker.transferred, 450, 'transferred tracks the cumulative')
})

test('eta is 0 once transferred reaches total', (t) => {
  let clock = 0
  const emits = []
  const ticker = makeProgressTicker(200, (p) => emits.push(p), { now: () => clock })
  clock = 300; ticker.push(200) // first emit, already complete
  t.is(emits[0].bytes, 200)
  t.is(emits[0].eta, 0, 'no time remaining when done')
})
