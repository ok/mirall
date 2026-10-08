import test from 'brittle'
import { IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED } from '../../src/shared/contract/ipc-frames.js'
import { Duplex } from 'streamx'
import { loadWithFakeElectron } from '../helpers/fake-electron.js'
import { preloadEntrypoints } from '../../src/main/worker-entrypoints.js'
import { MAIN_WORKER_SPEC } from '../../src/shared/contract/workers.js'
import { seedFile, _sealForTests } from '../../src/main/relay-secret.js'
import path from 'path'
import fs from 'fs'
import os from 'os'
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

// The gate and the flags module are reloaded with the host, so no test inherits another's
// packaging or flags cache.
function load({ worker = stubWorker(), config = {}, flags = {}, isPackaged = false, flagsRoot = null, storage = '/tmp/mirall-test' } = {}) {
  const { electron, modules } = loadWithFakeElectron(
    ['src/main/env-overrides.js', 'src/main/feature-flags.js', 'src/main/settings-ipc.js', 'src/main/worker-host.js'],
    { app: { isPackaged } },
  )
  const [, featureFlags, settings, host] = modules
  if (flagsRoot) featureFlags.primeFeatureFlags(flagsRoot)
  const store = {
    get: (k) => config[k],
    set: () => {},
    getBandwidth: () => ({ downloadKBps: 0, uploadKBps: 0 }),
    setBandwidth: () => {},
  }
  settings.initSettings({ config: () => store })
  host.initWorkerHost({
    config: () => store,
    getPear: () => ({ run: () => worker, storage }),
    isDev: true,
    identityKEK: () => flags.identityKEK ?? null,
  })
  return { host, worker, electron }
}

function frames(worker) {
  return worker.written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  t.teardown(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

test('the membership control binding reaches the worker off unless feature-flags.json turns it on', (t) => {
  const off = load()
  off.host.getWorker(MAIN_WORKER_SPEC)
  t.is(frames(off.worker)[1].membershipControlBindingEnforced, false)
  withEnv(t, { MIRALL_FEATURE_FLAGS: JSON.stringify({ membershipControlBinding: true }) })
  const on = load()
  on.host.getWorker(MAIN_WORKER_SPEC)
  t.is(frames(on.worker)[1].membershipControlBindingEnforced, true)
})

test('topic-ref enforcement reaches the worker off unless feature-flags.json turns it on', (t) => {
  const off = load()
  off.host.getWorker(MAIN_WORKER_SPEC)
  t.is(frames(off.worker)[1].topicRefsEnforced, false)
  withEnv(t, { MIRALL_FEATURE_FLAGS: JSON.stringify({ topicRefs: true }) })
  const on = load()
  on.host.getWorker(MAIN_WORKER_SPEC)
  t.is(frames(on.worker)[1].topicRefsEnforced, true)
})

test('REGRESSION (MIR-54: a packaged build took security flags from its environment): the MIRALL_* levers are ignored when packaged', (t) => {
  withEnv(t, {
    MIRALL_FEATURE_FLAGS: JSON.stringify({ membershipControlBinding: true }),
    MIRALL_DHT_BOOTSTRAP: JSON.stringify([{ host: '127.0.0.1', port: 1 }]),
    MIRALL_LIST_FILES_CAP: '3',
    MIRALL_MAX_FILES_PER_SHARE: '3',
    MIRALL_DERIVE_DEBOUNCE_MS: '3',
    MIRALL_FREE_UP_MIN_BYTES: '3',
    MIRALL_DOWNLOAD_FOLDER: '/tmp/mirall-elsewhere',
  })
  const packaged = load({ isPackaged: true })
  packaged.host.getWorker(MAIN_WORKER_SPEC)
  const boot = frames(packaged.worker)[1]
  t.is(boot.membershipControlBindingEnforced, false, 'the environment cannot change enforcement')
  t.absent(boot.dhtBootstrap, 'nor move the DHT')
  t.absent(boot.listFilesCap, 'nor lift a cap')
  t.absent(boot.maxFilesPerShare, 'nor the share admission gate')
  t.absent(boot.deriveDebounceMs, 'nor retime the fold')
  t.absent(boot.freeUpMinBytes, 'nor move the free-up threshold')
  t.not(boot.downloadFolder, '/tmp/mirall-elsewhere', 'nor redirect downloads')

  const dev = load()
  dev.host.getWorker(MAIN_WORKER_SPEC)
  const devBoot = frames(dev.worker)[1]
  t.is(devBoot.membershipControlBindingEnforced, true, 'an unpackaged run still honours the override')
  t.is(devBoot.listFilesCap, 3, 'and the test levers')
  t.is(devBoot.downloadFolder, '/tmp/mirall-elsewhere')
})

test('the rollback levers stay settable on a packaged build', (t) => {
  withEnv(t, { MIRALL_FOREIGN_FULL_WALK_EVERY: '1', MIRALL_LIST_FULL_READ_EVERY: '1' })
  const { host, worker } = load({ isPackaged: true })
  host.getWorker(MAIN_WORKER_SPEC)
  t.is(frames(worker)[1].foreignFullWalkEvery, 1)
  t.is(frames(worker)[1].listFullReadEvery, 1)
})

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

test('the bootstrap carries the relay seed the identity KEK unseals', (t) => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-host-relay-')), 'app-storage')
  t.teardown(() => fs.rmSync(path.dirname(storage), { recursive: true, force: true }))
  const identityKEK = 'cd'.repeat(32)
  const seed = 'ef'.repeat(32)
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(seedFile(storage), _sealForTests(seed, identityKEK))

  const { host, worker } = load({ flags: { identityKEK }, storage })
  host.getWorker(MAIN_WORKER_SPEC)
  t.is(frames(worker)[1].relaySeed, seed)
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
