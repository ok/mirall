import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// src/renderer/ipc/ipc.ts reaches window.bridge and only runs inside Electron, so the rules it holds
// across a worker death are pinned structurally — the renderer-cancellation-wiring.test.js pattern.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(path.join(root, 'src', 'renderer', 'ipc', 'ipc.ts'), 'utf8')

const section = (from, to) => src.slice(src.indexOf(from), src.indexOf(to))

// REGRESSION (FIX-IPCGEN-1: the catch-up's failure handler called markReady() whatever had happened
// in the meantime. A worker exiting during the resume installs a fresh readiness promise, which the
// handler then resolved with no worker alive: every request parked for the respawn woke and
// dispatched into a dead pipe, turning a clean park-and-retry into a 30s timeout each.)
test('REGRESSION (FIX-IPCGEN-1: the catch-up reports ready only for the worker that greeted us)', (t) => {
  t.ok(/let workerGeneration = 0/.test(src), 'a generation counter exists')
  t.ok(/function onWorkerExit[\s\S]{0,200}?workerGeneration \+= 1/.test(src),
    'and every worker exit bumps it')

  const settle = section('async function settleArrival', 'function handleLine')
  t.ok(/settleArrival\(coords: \{ epoch: string, head: number \}, generation: number\)/.test(settle),
    'the catch-up is told which generation it started against')
  t.ok(/if \(generation !== workerGeneration\) return\s*\n\s*markReady\(\)/.test(settle),
    'and reports ready only while that generation is still the live one')

  const arrival = section("if (msg.type === 'event:worker-ready')", '// Per-listener isolation')
  t.ok(/const greeted = workerGeneration/.test(arrival), 'the greeting records the generation it arrived on')
  t.ok(/\.catch\(\(err\) => \{[\s\S]*?if \(greeted !== workerGeneration\) return/.test(arrival),
    'and the failure handler bails before resyncing or marking ready for a worker that is gone')
})

// REGRESSION (FIX-CURSOR-2: main holds one worker connection across renderers, so a window that
// comes up over a running worker — a reload, or re-opening from the tray or the dock — never
// receives the greeting and holds no epoch. The next greeting it saw was a NEW process, and an
// empty cursor read as a first connection: no resync, so every cached answer, faulted entry and
// per-connection subscription from the dead generation survived for the rest of the session.)
test('REGRESSION (FIX-CURSOR-2: a readiness pong tells the cursor it is live but ungreeted)', (t) => {
  const probe = section('function probeWorkerReady', 'if (typeof window !==')
  t.ok(/resolve: \(\) => \{ clearTimeout\(reap\); cursor\.connected\(\); markReady\(\) \}/.test(probe),
    'the pong that stands in for the greeting marks the cursor connected before readiness')
})
