import test from 'brittle'
import { IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED } from '../../src/shared/contract/ipc-frames.js'
import { Duplex } from 'streamx'
import { loadWithFakeElectron } from '../helpers/fake-electron.js'
import { preloadEntrypoints } from '../../src/main/worker-entrypoints.js'
import { MAIN_WORKER_SPEC } from '../../src/shared/contract/workers.js'
import path from 'path'
import { fileURLToPath } from 'url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
preloadEntrypoints(REPO)

// The worker host is what stands between a renderer click and a Bare subprocess, and its rules are
// all about failure: one guarded write path, a bootstrap that must land or the spawn is not a
// spawn, a write failure reported once, and a dead worker that stops authorising anything. None of
// that was reachable before the host left the entry — the assertions were regexes over source.

function stubWorker() {
  const w = new Duplex({ write(_data, cb) { cb(null) } })
  w.written = []
  w.destroyed_ = false
  const realWrite = w.write.bind(w)
  w.write = (chunk) => { w.written.push(String(chunk)); return w.writeBehaviour ? w.writeBehaviour(chunk) : realWrite(chunk) }
  w.destroy = () => { w.destroyed_ = true }
  w._process = { kill: () => { w.killed = true } }
  // The host mirrors both streams into the log ring, so a stub without them is not a worker.
  w.stdout = new Duplex({ read() {} })
  w.stderr = new Duplex({ read() {} })
  return w
}

function load({ worker = stubWorker(), config = {}, flags = {} } = {}) {
  const { electron, modules } = loadWithFakeElectron(['src/main/settings-ipc.js', 'src/main/worker-host.js'])
  const [settings, host] = modules
  const store = {
    get: (k) => config[k],
    set: () => {},
    getBandwidth: () => ({ downloadKBps: 0, uploadKBps: 0 }),
    setBandwidth: () => {},
  }
  settings.initSettings({ config: () => store })
  host.initWorkerHost({
    config: () => store,
    getPear: () => ({ run: () => worker, storage: '/tmp/mirall-test' }),
    isDev: true,
    identityKEK: () => flags.identityKEK ?? null,
  })
  return { host, worker, electron }
}

function frames(worker) {
  return worker.written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('REGRESSION (FIX-BOOTSTRAP-1): the bootstrap frame goes down the one guarded path', (t) => {
  const { host, worker } = load()
  host.getWorker(MAIN_WORKER_SPEC)
  const sent = frames(worker)
  t.is(sent.length, 2, 'exactly two frames are written at spawn')
  t.is(sent[0].type, 'hello', 'the introduction first — nothing after it is honoured without one')
  t.is(sent[1].type, 'bootstrap', 'and then the payload')
})

test('REGRESSION (FIX-BOOTSTRAP-2): a worker whose bootstrap never landed is not cached', (t) => {
  const worker = stubWorker()
  worker.writeBehaviour = () => { throw new Error('EPIPE') }
  const { host } = load({ worker })
  t.exception(() => host.getWorker(MAIN_WORKER_SPEC), 'the spawn fails rather than returning a mute worker')
  t.ok(worker.destroyed_, 'the half-spawned worker is destroyed')

  // The second call must spawn again rather than hand back the failed one.
  const second = stubWorker()
  const again = load({ worker: second })
  again.host.getWorker(MAIN_WORKER_SPEC)
  t.is(frames(second).length, 2, 'a later spawn writes its own handshake')
})

test('REGRESSION (FIX-EPIPE-1): a stream error racing worker death is consumed', (t) => {
  const { host, worker } = load()
  host.getWorker(MAIN_WORKER_SPEC)
  t.ok(worker.listenerCount('error') > 0, 'getWorker attaches an error listener in the same block as the spawn')
  t.execution(() => worker.emit('error', new Error('write EPIPE')), 'so an async EPIPE is not an uncaught exception')
})

test('REGRESSION (FIX-ROOTS-1): a dead worker stops authorising reveals', (t) => {
  const { host, worker } = load()
  host.getWorker(MAIN_WORKER_SPEC)
  t.alike(host.downloadRoots(), [], 'no roots before the worker reports any')
  worker.emit('exit')
  t.alike(host.downloadRoots(), [], 'and none after it dies')
})

test('REGRESSION (FIX-ENVJSON-1): a malformed DHT knob does not take the spawn with it', (t) => {
  const prev = process.env.MIRALL_DHT_BOOTSTRAP
  process.env.MIRALL_DHT_BOOTSTRAP = '{not json'
  t.teardown(() => { if (prev === undefined) delete process.env.MIRALL_DHT_BOOTSTRAP; else process.env.MIRALL_DHT_BOOTSTRAP = prev })
  const { host, worker } = load()
  t.execution(() => host.getWorker(MAIN_WORKER_SPEC), 'the knob is read through envJson, which swallows and warns')
  t.absent(frames(worker)[1].dhtBootstrap, 'and the field is simply absent from the bootstrap')
})

test('the bootstrap frame carries the configured download concurrency', (t) => {
  const { host, worker } = load({ config: { 'network.downloadConcurrency': 7 } })
  host.getWorker(MAIN_WORKER_SPEC)
  t.is(frames(worker)[1].downloadConcurrency, 7, 'the knob is wired at both ends')
})

test('the identity KEK is read at spawn time, not at require time', (t) => {
  const { host, worker } = load({ flags: { identityKEK: 'deadbeef' } })
  host.getWorker(MAIN_WORKER_SPEC)
  t.is(frames(worker)[1].identityKEK, 'deadbeef',
    'resolved inside whenReady, after this module loads and before the first spawn')
})

test('the hello frame carries the protocol version, the window main accepts, and what main is', (t) => {
  const { host, worker } = load()
  host.getWorker('/src/worker/main.js')
  const [hello] = frames(worker).filter((f) => f.type === 'hello')
  t.is(hello.protocolVersion, IPC_PROTOCOL_VERSION)
  t.is(hello.protocolMin, IPC_PROTOCOL_MIN_SUPPORTED)
  t.is(hello.protocolMax, IPC_PROTOCOL_VERSION, 'main accepts exactly the version it speaks')
  t.is(hello.client.kind, 'electron-main', 'and says which program is on the other end')
  const [boot] = frames(worker).filter((f) => f.type === 'bootstrap')
  t.absent(boot.protocolVersion, 'the version rides the introduction, not the payload')
})

test('stopWorker resolves once the worker has actually exited', async (t) => {
  const { host, worker } = load()
  host.getWorker('/src/worker/main.js')
  let settled = false
  const stopped = host.stopWorker(worker).then(() => { settled = true })

  const [shutdown] = frames(worker).filter((f) => f.type === 'shutdown')
  t.ok(shutdown, 'it asks first, and lets the worker close the swarm itself')
  t.absent(settled, 'and does not resolve until the process is gone')

  worker.emit('exit', 0)
  await stopped
  t.ok(settled, 'the promise is what makes a restart able to wait for the stop')
})

test('stopWorkers still reaches every worker', (t) => {
  const { host, worker } = load()
  host.getWorker('/src/worker/main.js')
  host.stopWorkers()
  t.is(frames(worker).filter((f) => f.type === 'shutdown').length, 1)
})
