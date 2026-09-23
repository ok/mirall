import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { EventEmitter } from 'events'
import { createIPC } from '../../src/shared/core/ipc.js'
import { sayHello } from '../helpers/ipc-hello.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workerDir = path.join(here, '..', '..', 'src', 'worker')

// The entry and the handler modules it registers are one wiring surface: a handler moving from
// main.js into src/worker/ipc/ must not be able to drop a context field on the way.
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : [])
  })
}
const mainEntry = readFileSync(path.join(workerDir, 'main.js'), 'utf8')
const entry = [mainEntry, ...walk(path.join(workerDir, 'ipc')).map((f) => readFileSync(f, 'utf8'))].join('\n')

// The producer being correct proves nothing about the export: requestFailures (#118) and
// requestMetrics (#120) were both built, tested and shipped as no-ops because nothing handed them
// to buildDiagnostics. That wiring runs at module scope under the worker entry — importing it
// would boot the data layer and exit the process — so it is pinned by source text, the same way
// the crash-backstop suite pins the core-opening call sites in boot.js. The router's own numbers
// travel the same hop and are pinned on the VALUE that comes out, in
// test/integration/diagnostics-router-wiring.test.js.
test('REGRESSION (FIX-R09-7): the entry feeds the health block into the diagnostics context', (t) => {
  t.ok(/health:\s*health\.snapshot\(/.test(entry), 'diagnostics ctx carries health: health.snapshot(...)')
})

test('REGRESSION (FIX-R09-7): the entry starts and stops the monitor', (t) => {
  t.ok(/health\.start\(\)/.test(mainEntry), 'started when the router goes live')
  t.ok(/health\.stop\(\)/.test(mainEntry), 'and stopped on shutdown, so it cannot outlive the worker')
  // Statement positions, not the first textual match: a prose comment near the top of the entry
  // also names ipc.start(), and indexOf would score that instead.
  const startedAt = mainEntry.search(/^health\.start\(\)$/m)
  const liveAt = mainEntry.search(/^ipc\.start\(\)$/m)
  t.ok(startedAt > 0 && liveAt > 0, 'both are real statements, not only mentioned in comments')
  t.ok(startedAt < liveAt, 'armed just before the router admits its first frame, not during boot I/O')
})

function fakePipe() {
  const pipe = new EventEmitter()
  pipe.written = []
  pipe.write = (s) => { pipe.written.push(s); return true }
  pipe.feed = (obj) => pipe.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  return pipe
}

const QUEUE_REQUESTS = Object.freeze({ 'q:one': { kind: 'command', args: {} } })

test('queueDepth reports frames parked before the router goes live', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: QUEUE_REQUESTS })
  sayHello(pipe)
  ipc.handle('q:one', async () => null)
  pipe.feed({ id: '1', type: 'q:one' })
  pipe.feed({ id: '2', type: 'q:one' })
  await new Promise((r) => setImmediate(r))
  t.is(ipc.queueDepth(), 2, 'the parked frames are visible')
  ipc.start()
  await new Promise((r) => setImmediate(r))
  t.is(ipc.queueDepth(), 0, 'and the queue drains when it goes live')
})

test('REGRESSION (FIX-R09-2): the entry feeds the per-subsystem health into the same block', (t) => {
  t.ok(/subsystems:\s*root\?\.health\(\)/.test(entry), 'diagnostics ctx carries subsystems: root?.health()')
})
