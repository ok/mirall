import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { EventEmitter } from 'events'
import { createIPC, getQueueDepth } from '../../src/shared/core/ipc.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = readFileSync(path.join(here, '..', '..', 'src', 'worker', 'main.js'), 'utf8')

// The producer being correct proves nothing about the export: requestFailures (#118) and
// requestMetrics (#120) were both built, tested and shipped as no-ops because the entry never
// handed them to buildDiagnostics. That wiring is module-scope code in worker/main.js — importing
// it would boot the data layer and exit the process — so it is pinned by source text, the same way
// the crash-backstop suite pins the core-opening call sites in boot.js.
test('REGRESSION (FIX-R09-7): the entry feeds the health block into the diagnostics context', (t) => {
  t.ok(/health:\s*health\.snapshot\(/.test(entry), 'diagnostics ctx carries health: health.snapshot(...)')
  t.ok(/queueDepth:\s*getQueueDepth\(\)/.test(entry), 'and the queue depth is measured, not hard-coded')
})

test('REGRESSION (FIX-R09-7): the entry starts and stops the monitor', (t) => {
  t.ok(/health\.start\(\)/.test(entry), 'started when the router goes live')
  t.ok(/health\.stop\(\)/.test(entry), 'and stopped on shutdown, so it cannot outlive the worker')
  // Statement positions, not the first textual match: a prose comment near the top of the entry
  // also names ipc.start(), and indexOf would score that instead.
  const startedAt = entry.search(/^health\.start\(\)$/m)
  const liveAt = entry.search(/^ipc\.start\(\)$/m)
  t.ok(startedAt > 0 && liveAt > 0, 'both are real statements, not only mentioned in comments')
  t.ok(startedAt < liveAt, 'armed just before the router admits its first frame, not during boot I/O')
})

function fakePipe () {
  const pipe = new EventEmitter()
  pipe.written = []
  pipe.write = (s) => { pipe.written.push(s); return true }
  pipe.feed = (obj) => pipe.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  return pipe
}

const QUEUE_REQUESTS = Object.freeze({ 'q:one': { kind: 'command', args: {} } })

test('getQueueDepth reports frames parked before the router goes live', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: QUEUE_REQUESTS })
  ipc.handle('q:one', async () => null)
  pipe.feed({ id: '1', type: 'q:one' })
  pipe.feed({ id: '2', type: 'q:one' })
  await new Promise((r) => setImmediate(r))
  t.is(getQueueDepth(), 2, 'the parked frames are visible')
  ipc.start()
  await new Promise((r) => setImmediate(r))
  t.is(getQueueDepth(), 0, 'and the queue drains when it goes live')
})
