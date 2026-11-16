import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { tmpDir } from '../helpers/bare-tmp.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { offlineMemberRegistry } from '../helpers/store.js'
import { boot } from '../../src/worker/boot.js'
import { loadSettings, getSettings } from '../../src/shared/core/settings-store.js'
import { assembleRuntimeConfig } from '../../src/shared/core/runtime-config-sources.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { loadTestRun, TEST_RUN_FILE } from '../../src/shared/core/test-run-file.js'
import { traceEvent } from '../../src/shared/transfer/trace/trace-sink.js'
import { TRACE_EVENTS } from '../../src/shared/transfer/trace/trace-record.js'
import { createTraceFile, TRACE_DIR, TRACE_FILE, TRACE_PREVIOUS_FILE } from '../../src/shared/transfer/trace/trace-file.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

// The worker entry's own sequence, with the test run file where the script would have put it.
async function bootWith(t, testRunText) {
  const root = tmpDir('transfer-trace', t)
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  if (testRunText !== null) fs.writeFileSync(path.join(root, TEST_RUN_FILE), testRunText)
  const bootstrap = { storage, appVersion: '1.14.0-beta.90', dev: true, verbose: false }
  await loadSettings(storage)
  const { testRun, broken } = loadTestRun(storage)
  setRuntimeConfig(assembleRuntimeConfig({ bootstrap, settings: getSettings(), flags: {}, testRun }))
  const worker = await boot(bootstrap, { ipc: createFakeIpc().ipc, log: quiet, swarm: false, masterSecret: crypto.randomBytes(32), memberRegistry: offlineMemberRegistry })
  let closed = false
  const close = async () => { if (!closed) { closed = true; await worker.close() } }
  t.teardown(async () => { try { await close() } catch {} }, { order: 1 })
  return { root, broken, close, traceFile: path.join(root, TRACE_DIR, TRACE_FILE) }
}

const linesOf = (file) => fs.readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
const fakeSocket = () => ({ once() {}, rawStream: null })

test('with no test run file nothing is recorded and no folder appears', async (t) => {
  const h = await bootWith(t, null)
  traceEvent(TRACE_EVENTS.CONN_OPEN, { socket: fakeSocket() })
  t.absent(fs.existsSync(path.join(h.root, TRACE_DIR)))
  t.is(h.broken, null, 'a missing file is not a broken one')
})

test('a test run file that cannot be read is reported and leaves the app as shipped', async (t) => {
  const h = await bootWith(t, '{ "run": "R1", "trace": tr')
  t.ok(h.broken, 'the reason is handed back for the log')
  t.absent(fs.existsSync(path.join(h.root, TRACE_DIR)))
})

test('the test run file turns the trace on: a header, then each event with numbers only', async (t) => {
  const h = await bootWith(t, JSON.stringify({ run: 'R3', trace: true }))
  const socket = fakeSocket()
  traceEvent(TRACE_EVENTS.CONN_OPEN, { socket })
  traceEvent(TRACE_EVENTS.FETCH_START, { key: '/Users/someone/Downloads/report.pdf' })
  traceEvent(TRACE_EVENTS.HANDBACK, { key: '/Users/someone/Downloads/report.pdf', socket, n: 4 })
  traceEvent(TRACE_EVENTS.FETCH_END, { key: '/Users/someone/Downloads/report.pdf', ok: false })
  traceEvent(TRACE_EVENTS.CONN_CLOSE, { socket })

  const text = fs.readFileSync(h.traceFile, 'utf-8')
  t.absent(text.includes('report') || text.includes('someone'), 'the destination path stays in memory')
  const [header, ...events] = linesOf(h.traceFile)
  t.alike({ ...header, t: 0, platform: 'x', arch: 'x' }, { t: 0, k: 'header', v: 1, app: '1.14.0-beta.90', run: 'R3', platform: 'x', arch: 'x' })
  t.alike(events.map(({ t: _at, k: _kind, ...rest }) => rest), [
    { e: 'conn-open', c: 1 },
    { e: 'fetch-start', x: 1 },
    { e: 'handback', c: 1, x: 1, n: 4 },
    { e: 'fetch-end', x: 1, ok: false },
    { e: 'conn-close', c: 1 },
  ])

  await h.close()
  const before = fs.statSync(h.traceFile).size
  traceEvent(TRACE_EVENTS.CONN_OPEN, { socket: fakeSocket() })
  t.is(fs.statSync(h.traceFile).size, before, 'a closed trace records nothing more')
})

test('the trace on disk is bounded: a full file is set aside once, replacing the one before', (t) => {
  const dir = path.join(tmpDir('trace-file', t), TRACE_DIR)
  const file = createTraceFile({ dir, maxBytes: 100 })
  const line = (n) => JSON.stringify({ n, pad: 'x'.repeat(30) })
  file.append([line(1)])
  file.append([line(2)])
  t.absent(fs.existsSync(file.previous), 'under the limit: one file')
  file.append([line(3)])
  t.alike(linesOf(file.previous).map((l) => l.n), [1, 2], 'the full file was set aside')
  t.alike(linesOf(file.file).map((l) => l.n), [3])
  file.append([line(4)])
  file.append([line(5)])
  t.alike(linesOf(file.previous).map((l) => l.n), [3, 4], 'and replaced by the next full one')
  t.alike(fs.readdirSync(dir).sort(), [TRACE_FILE, TRACE_PREVIOUS_FILE].sort(), 'never more than two files')

  const reopened = createTraceFile({ dir, maxBytes: 100 })
  reopened.append([line(6)])
  t.alike(linesOf(reopened.file).map((l) => l.n), [5, 6], 'a restart appends to the file it finds')
})
