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
import net from 'net'
import { EventEmitter } from 'events'
import { fileURLToPath } from 'url'

// Each load() installs its own process-exit backstop, as each real spawn path does.
process.setMaxListeners(100)

const KEK = 'ab'.repeat(32)
const SEED = 'ef'.repeat(32)

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
preloadEntrypoints(REPO)

// The worker host is what stands between a renderer click and a Bare subprocess, and its rules are
// all about failure: one guarded write path, a bootstrap that must land or the spawn is not a
// spawn, a write failure reported once, and a dead worker that stops authorising anything. None of
// that was reachable before the host left the entry — the assertions were regexes over source.

// `exitsOnShutdown` plays a worker that leaves when asked to: the shutdown frame ends its process.
function stubWorker({ exitsOnShutdown = false } = {}) {
  const w = new Duplex({ write(_data, cb) { cb(null) } })
  w.written = []
  w.destroyed_ = false
  const realWrite = w.write.bind(w)
  w.write = (chunk) => {
    w.written.push(String(chunk))
    if (exitsOnShutdown && String(chunk).includes('"shutdown"')) setImmediate(() => w.emit('exit', 0))
    return w.writeBehaviour ? w.writeBehaviour(chunk) : realWrite(chunk)
  }
  w.destroy = () => { w.destroyed_ = true }
  w._process = { kill: () => { w.killed = true } }
  // The host mirrors both streams into the log ring, so a stub without them is not a worker.
  w.stdout = new Duplex({ read() {} })
  w.stderr = new Duplex({ read() {} })
  return w
}

// The gate is reloaded with the host, so no test inherits another's packaging.
function load({ worker = stubWorker(), spawn = () => worker, config = {}, flags = {}, isPackaged = false, storage = '/tmp/mirall-test' } = {}) {
  const { electron, modules } = loadWithFakeElectron(
    ['src/main/env-overrides.js', 'src/main/settings-ipc.js', 'src/main/worker-host.js'],
    { app: { isPackaged, getPath: () => '/tmp/mirall-test-downloads' } },
  )
  const [, settings, host] = modules
  const store = { get: (k) => config[k], set: () => {} }
  settings.initSettings({ config: () => store })
  host.initWorkerHost({
    config: () => store,
    getPear: () => ({ run: () => spawn(), storage }),
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

test('a flag override rides the bootstrap as an object the worker merges over feature-flags.json', (t) => {
  const plain = load()
  plain.host.getWorker(MAIN_WORKER_SPEC)
  t.absent('featureFlags' in frames(plain.worker)[1], 'absent when nothing overrides')
  withEnv(t, { MIRALL_FEATURE_FLAGS: JSON.stringify({ topicRefs: true }) })
  const on = load()
  on.host.getWorker(MAIN_WORKER_SPEC)
  t.alike(frames(on.worker)[1].featureFlags, { topicRefs: true })
})

test('the bootstrap carries host facts and levers, never a preference or a flag', (t) => {
  const { host, worker } = load({ config: { 'network.downloadConcurrency': 7, 'downloads.folder': '/elsewhere' } })
  host.getWorker(MAIN_WORKER_SPEC)
  const boot = frames(worker)[1]
  t.is(boot.defaultDownloadFolder, '/tmp/mirall-test-downloads', 'the OS downloads folder is a host fact')
  for (const key of ['downloadFolder', 'downloadKBps', 'uploadKBps', 'relayMode', 'relay', 'downloadConcurrency', 'backupFolder', 'backupRepoId', 'membershipControlBindingEnforced', 'topicRefsEnforced']) {
    t.absent(key in boot, key + ' is the worker\'s own')
  }
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
  t.absent(boot.featureFlags, 'the environment cannot change enforcement')
  t.absent(boot.dhtBootstrap, 'nor move the DHT')
  t.absent(boot.listFilesCap, 'nor lift a cap')
  t.absent(boot.maxFilesPerShare, 'nor the share admission gate')
  t.absent(boot.deriveDebounceMs, 'nor retime the fold')
  t.absent(boot.freeUpMinBytes, 'nor move the free-up threshold')
  t.not(boot.downloadFolder, '/tmp/mirall-elsewhere', 'nor redirect downloads')

  const dev = load()
  dev.host.getWorker(MAIN_WORKER_SPEC)
  const devBoot = frames(dev.worker)[1]
  t.alike(devBoot.featureFlags, { membershipControlBinding: true }, 'an unpackaged run still honours the override')
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
  t.alike(host.revealRoots(), [], 'no roots before the worker reports any')
  worker.emit('exit')
  t.alike(host.revealRoots(), [], 'and none after it dies')
})

// The shell gate admits a daemon path only on this fact, and it is a fact about the worker THIS
// window claimed: a window on a daemon main did not spawn is vouched for by nothing.
test('a window’s worker is known local exactly while the one it claimed is one this process spawned', async (t) => {
  const { socketPath } = await socketServer(t)
  const { host, worker, electron } = load({ flags: { identityKEK: KEK } })
  host.registerWorkerHost()
  const sender = fakeSender(7)
  t.absent(host.workerIsLocal(sender.id), 'nothing claimed, nothing vouched for')
  const starting = startFor(electron, sender)
  worker.emit('data', announce(socketPath))
  await starting
  t.ok(host.workerIsLocal(sender.id), 'the window’s worker is one this process spawned')
  t.absent(host.workerIsLocal(8), 'another window has claimed nothing')
  worker.emit('exit')
  t.absent(host.workerIsLocal(sender.id), 'and its death withdraws the fact')
})

test('REGRESSION (FIX-ENVJSON-1): a malformed DHT knob does not take the spawn with it', (t) => {
  const prev = process.env.MIRALL_DHT_BOOTSTRAP
  process.env.MIRALL_DHT_BOOTSTRAP = '{not json'
  t.teardown(() => { if (prev === undefined) delete process.env.MIRALL_DHT_BOOTSTRAP; else process.env.MIRALL_DHT_BOOTSTRAP = prev })
  const { host, worker } = load()
  t.execution(() => host.getWorker(MAIN_WORKER_SPEC), 'the knob is read through envJson, which swallows and warns')
  t.absent(frames(worker)[1].dhtBootstrap, 'and the field is simply absent from the bootstrap')
})

test('no secret rides the bootstrap, whatever the host holds', (t) => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-host-relay-')), 'app-storage')
  t.teardown(() => fs.rmSync(path.dirname(storage), { recursive: true, force: true }))
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(seedFile(storage), _sealForTests(SEED, KEK))

  const { host, worker } = load({ flags: { identityKEK: KEK }, storage })
  host.getWorker(MAIN_WORKER_SPEC)
  const line = worker.written.join('')
  t.absent('identityKEK' in frames(worker)[1], 'no identity key field')
  t.absent('relaySeed' in frames(worker)[1], 'no relay seed field')
  t.absent(line.includes(KEK), 'the key is nowhere on the pipe')
  t.absent(line.includes(SEED), 'nor the seed it unseals')
})

test('the unlock request carries the key read at spawn time and the relay seed it unseals', async (t) => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-host-relay-')), 'app-storage')
  t.teardown(() => fs.rmSync(path.dirname(storage), { recursive: true, force: true }))
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(seedFile(storage), _sealForTests(SEED, KEK))

  const flags = { identityKEK: 'cd'.repeat(32) }
  const server = await socketServer(t)
  const { host, worker, electron } = load({ flags, storage })
  host.registerWorkerHost()
  const starting = startFor(electron, fakeSender(7))
  flags.identityKEK = KEK
  worker.emit('data', announce(server.socketPath))
  await starting
  t.is(server.unlocks.length, 1)
  t.is(server.unlocks[0].type, 'identity:unlock')
  t.is(server.unlocks[0].kek, 'cd'.repeat(32), 'the key of the spawn, not a later one')
  t.is(server.unlocks[0].relaySeed, undefined, 'a seed sealed under another key is not handed over')
  t.is(server.hellos[0].client.kind, 'electron-main', 'main introduces itself before it asks')
})

test('the relay seed the identity key unseals goes with the key', async (t) => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-host-relay-')), 'app-storage')
  t.teardown(() => fs.rmSync(path.dirname(storage), { recursive: true, force: true }))
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(seedFile(storage), _sealForTests(SEED, KEK))

  const server = await socketServer(t)
  const { host, worker, electron } = load({ flags: { identityKEK: KEK }, storage })
  host.registerWorkerHost()
  const starting = startFor(electron, fakeSender(7))
  worker.emit('data', announce(server.socketPath))
  await starting
  t.is(server.unlocks[0].kek, KEK)
  t.is(server.unlocks[0].relaySeed, SEED)
})

test('a window is told the worker started only once the unlock has settled', async (t) => {
  const server = await socketServer(t, { holdUnlock: true })
  const { host, worker, electron } = load({ flags: { identityKEK: KEK } })
  host.registerWorkerHost()
  const sender = fakeSender(7)
  let started = false
  const starting = startFor(electron, sender).then((v) => { started = v })
  worker.emit('data', announce(server.socketPath))
  await until(() => server.unlocks.length === 1)
  await new Promise((r) => setTimeout(r, 30))
  t.absent(started, 'the worker has the key request and has not answered it')
  t.is(server.peers.length, 1, 'the window has not connected: it would see a worker that still waits')

  server.releaseUnlock()
  await starting
  t.ok(started)
  await until(() => server.peers.length === 2)
  t.is(server.peers.length, 2, 'the window connects once it has settled')
})

test('a worker that locked on its key is a started worker, and the window gets the locked screen', async (t) => {
  for (const code of ['IDENTITY_UNLOCK_FAILED', 'IDENTITY_PROVIDER_MISMATCH']) {
    const server = await socketServer(t, { unlock: () => ({ error: 'identity unlock failed', code }) })
    const { host, worker, electron } = load({ flags: { identityKEK: KEK } })
    host.registerWorkerHost()
    const starting = startFor(electron, fakeSender(7))
    worker.emit('data', announce(server.socketPath))
    t.is(await starting, true, code + ': the start resolves')
    t.absent(worker.destroyed_, 'the worker is kept: it serves the recoveries')
    t.is(host.getWorker(MAIN_WORKER_SPEC), worker, 'and stays the cached one')
  }
})

test('any other failure of the unlock is a failed spawn: stopped, not cached, raised', async (t) => {
  const refusals = {
    'a code that is not a lock': () => ({ error: 'this worker is not waiting for a key', code: 'NOT_AUTHORIZED' }),
    'a connection that drops': () => 'hang-up',
  }
  for (const [name, unlock] of Object.entries(refusals)) {
    const server = await socketServer(t, { unlock })
    const first = stubWorker({ exitsOnShutdown: true })
    const second = stubWorker()
    const spawned = [first, second]
    const { host, electron } = load({ flags: { identityKEK: KEK }, spawn: () => spawned.shift() })
    host.registerWorkerHost()
    const starting = startFor(electron, fakeSender(7))
    first.emit('data', announce(server.socketPath))
    await t.exception(starting, name + ': the start fails')
    t.is(frames(first).filter((f) => f.type === 'shutdown').length, 1, name + ': the worker was asked to shut down')
    t.is(host.getWorker(MAIN_WORKER_SPEC), second, name + ': the next start spawns afresh')
    first.emit('exit', 1)
    t.is(host.getWorker(MAIN_WORKER_SPEC), second, name + ': the dead worker\'s exit does not evict its successor')
  }
})

test('REGRESSION (FIX-UNLOCK-3: a worker still holding the profile lock outlived its failed start): the start rejects only once the worker has exited', async (t) => {
  const server = await socketServer(t, { unlock: () => ({ error: 'this worker is not waiting for a key', code: 'NOT_AUTHORIZED' }) })
  const first = stubWorker()
  const second = stubWorker()
  const spawned = [first, second]
  const { host, electron } = load({ flags: { identityKEK: KEK }, spawn: () => spawned.shift() })
  host.registerWorkerHost()
  let rejected = false
  const starting = startFor(electron, fakeSender(7)).catch(() => { rejected = true })
  first.emit('data', announce(server.socketPath))
  await until(() => frames(first).some((f) => f.type === 'shutdown'))
  await new Promise((r) => setTimeout(r, 40))
  t.absent(rejected, 'the worker has been asked to go and has not: its lock may still be held')
  t.is(host.getWorker(MAIN_WORKER_SPEC), first, 'and it is still the worker the host knows, so the quit backstop covers it')

  first.emit('exit', 0)
  await starting
  t.ok(rejected)
  t.is(host.getWorker(MAIN_WORKER_SPEC), second, 'a successor spawns once it has gone')
  first.emit('exit', 0)
  t.is(host.getWorker(MAIN_WORKER_SPEC), second, 'and its late exit does not evict the successor')
})

test('a worker that had already exited when its start failed is not waited for', async (t) => {
  const worker = stubWorker()
  const { host, electron } = load({ worker, flags: { identityKEK: KEK } })
  host.registerWorkerHost()
  const starting = startFor(electron, fakeSender(7))
  worker.emit('exit', 73)
  await t.exception(starting)
  t.is(frames(worker).filter((f) => f.type === 'shutdown').length, 0, 'nobody to ask')
})

test('stopping the worker while its first unlock is in flight ends the start cleanly and harms no successor', async (t) => {
  const server = await socketServer(t, { holdUnlock: true })
  const first = stubWorker()
  const second = stubWorker()
  const spawned = [first, second]
  const { host, electron } = load({ flags: { identityKEK: KEK }, spawn: () => spawned.shift() })
  host.registerWorkerHost()
  const sender = fakeSender(7)
  const starting = startFor(electron, sender)
  first.emit('data', announce(server.socketPath))
  await until(() => server.unlocks.length === 1)

  const stopping = host.stopWorker(first)
  first.emit('exit', 0)
  await stopping
  server.peers.forEach((peer) => peer.destroy())
  await t.exception(starting, 'the pending start rejects')
  t.is(server.peers.length, 1, 'the window never connected')
  t.alike(sender.sent.filter(([c]) => c.startsWith('pear:worker:exit:')).map(([, code]) => code), [0], 'and heard of the exit once')
  t.is(host.getWorker(MAIN_WORKER_SPEC), second, 'nothing stale is cached')
  t.absent(second.destroyed_, 'and the successor is untouched')
})

test('a worker spawned with no key to give is a failed spawn', async (t) => {
  const server = await socketServer(t)
  const worker = stubWorker({ exitsOnShutdown: true })
  const { host, electron } = load({ worker })
  host.registerWorkerHost()
  const starting = startFor(electron, fakeSender(7))
  worker.emit('data', announce(server.socketPath))
  await t.exception(starting)
  t.is(server.unlocks.length, 0, 'nothing is asked of the worker')
  t.is(frames(worker).filter((f) => f.type === 'shutdown').length, 1)
})

test('neither the key nor the seed reaches a log, whether the unlock succeeds or fails', async (t) => {
  const storage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-host-relay-')), 'app-storage')
  t.teardown(() => fs.rmSync(path.dirname(storage), { recursive: true, force: true }))
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(seedFile(storage), _sealForTests(SEED, KEK))

  const logged = []
  const saved = {}
  for (const level of ['log', 'info', 'warn', 'error']) {
    saved[level] = console[level]
    console[level] = (...args) => { logged.push(args.map(String).join(' ')) }
  }
  t.teardown(() => { for (const level of Object.keys(saved)) console[level] = saved[level] })

  for (const unlock of [() => ({ data: { ok: true } }), () => ({ error: 'nope', code: 'NOT_AUTHORIZED' }), () => 'hang-up']) {
    const server = await socketServer(t, { unlock })
    const worker = stubWorker({ exitsOnShutdown: true })
    const { host, electron } = load({ worker, flags: { identityKEK: KEK }, storage })
    host.registerWorkerHost()
    const starting = startFor(electron, fakeSender(7))
    worker.emit('data', announce(server.socketPath))
    await starting.catch(() => {})
  }
  const text = logged.join('\n')
  t.absent(text.includes(KEK), 'no key in a log')
  t.absent(text.includes(SEED), 'no seed in a log')
})

test('a restart hands the key over again, as the key stands then', async (t) => {
  const server = await socketServer(t)
  const first = stubWorker()
  const second = stubWorker()
  const spawned = [first, second]
  const flags = { identityKEK: KEK }
  const { host, electron } = load({ flags, spawn: () => spawned.shift() })
  host.registerWorkerHost()
  const sender = fakeSender(7)
  const starting = startFor(electron, sender)
  first.emit('data', announce(server.socketPath))
  await starting
  t.is(server.unlocks.length, 1)

  flags.identityKEK = 'cd'.repeat(32)
  const restarting = host.restartWorker(MAIN_WORKER_SPEC)
  first.emit('exit', 0)
  await restarting
  const again = startFor(electron, sender)
  second.emit('data', announce(server.socketPath))
  await again
  t.is(server.unlocks.length, 2, 'every spawn is unlocked')
  t.is(server.unlocks[1].kek, 'cd'.repeat(32))
})

test('a respawn after a crash hands the key over again', async (t) => {
  const server = await socketServer(t)
  const first = stubWorker()
  const second = stubWorker()
  const spawned = [first, second]
  const { host, electron } = load({ flags: { identityKEK: KEK }, spawn: () => spawned.shift() })
  host.registerWorkerHost()
  const starting = startFor(electron, fakeSender(7))
  first.emit('data', announce(server.socketPath))
  await starting
  first.emit('exit', 70)

  const again = startFor(electron, fakeSender(7))
  second.emit('data', announce(server.socketPath))
  await again
  t.is(server.unlocks.length, 2)
})

test('"try again" hands the running worker the current key and reports whether it opened', async (t) => {
  const answers = [() => ({ error: 'identity unlock failed', code: 'IDENTITY_UNLOCK_FAILED' }), () => ({ data: { ok: true } })]
  const server = await socketServer(t, { unlock: () => answers.shift()() })
  const flags = { identityKEK: KEK }
  const { host, worker, electron } = load({ flags })
  host.registerWorkerHost()
  const starting = startFor(electron, fakeSender(7))
  worker.emit('data', announce(server.socketPath))
  await starting

  flags.identityKEK = 'cd'.repeat(32)
  t.is(await host.retryUnlock(MAIN_WORKER_SPEC), true, 'opened')
  t.is(server.unlocks.length, 2)
  t.is(server.unlocks[1].kek, 'cd'.repeat(32), 'the key held now, not the one of the spawn')
})

test('"try again" on a key that locks the worker again is false, not an error; a worker that is gone is an error', async (t) => {
  const server = await socketServer(t, { unlock: () => ({ error: 'identity unlock failed', code: 'IDENTITY_UNLOCK_FAILED' }) })
  const { host, worker, electron } = load({ flags: { identityKEK: KEK } })
  host.registerWorkerHost()
  const starting = startFor(electron, fakeSender(7))
  worker.emit('data', announce(server.socketPath))
  await starting
  t.is(await host.retryUnlock(MAIN_WORKER_SPEC), false)
  worker.emit('exit', 0)
  await t.exception(host.retryUnlock(MAIN_WORKER_SPEC))
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

function fakeSender(id) {
  const ee = new EventEmitter()
  ee.id = id
  ee.sent = []
  ee.isDestroyed = () => false
  ee.send = (channel, payload) => { ee.sent.push([channel, payload]) }
  return ee
}

// A worker's socket as far as main can tell: it answers identity:unlock as `unlock` says (an ok by
// default; `{ error, code }`; 'hang-up'), or holds the answer until releaseUnlock(). Every other
// connection is a window's, and what it sends is kept in `received`.
function socketServer(t, { unlock = () => ({ data: { ok: true } }), holdUnlock = false } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wh-')), 'run')
  fs.mkdirSync(dir, { mode: 0o700 })
  t.teardown(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }))
  const socketPath = path.join(dir, 's.sock')
  const peers = []
  const unlocks = []
  const hellos = []
  let release = null
  const held = new Promise((resolve) => { release = resolve })
  const server = net.createServer((sock) => {
    sock.received = []
    let buffered = ''
    sock.on('error', () => {})
    sock.on('data', (d) => {
      sock.received.push(String(d))
      buffered += d
      const lines = buffered.split('\n')
      buffered = lines.pop()
      for (const line of lines) {
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame.type === 'hello') hellos.push(frame)
        if (frame.type !== 'identity:unlock') continue
        unlocks.push(frame)
        void (async () => {
          if (holdUnlock) await held
          const answer = unlock(frame)
          if (answer === 'hang-up') { sock.destroy(); return }
          sock.write(JSON.stringify({ id: frame.id, type: 'response', ...answer }) + '\n')
        })()
      }
    })
    peers.push(sock)
  })
  const close = () => new Promise((resolve) => { for (const p of peers) p.destroy(); server.close(resolve) })
  t.teardown(close)
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, peers, unlocks, hellos, releaseUnlock: () => release(), close })))
}

const announce = (socketPath) => Buffer.from(JSON.stringify({ type: 'main-request', command: 'socket:listening', args: { path: socketPath } }) + '\n')
const startFor = (electron, sender) => electron.ipcMain.handlers.get('pear:startWorker')({ sender }, MAIN_WORKER_SPEC)

const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)) }

test('a window starts the worker, waits for its socket, and talks to it over its own connection', async (t) => {
  const { socketPath, peers } = await socketServer(t)
  const { host, worker, electron } = load({ flags: { identityKEK: KEK } })
  host.registerWorkerHost()
  const sender = fakeSender(7)
  let started = false
  const starting = startFor(electron, sender).then((v) => { started = v })

  await new Promise((r) => setTimeout(r, 20))
  t.absent(started, 'not before the worker said where it listens')
  worker.emit('data', announce(socketPath))
  await starting
  t.is(started, true)
  await until(() => peers.length === 2)
  t.is(peers.length, 2, 'main\'s own connection for the key, and one for the window')
  const windowPeer = peers[1]

  windowPeer.write('{"type":"event:x"}\n')
  await until(() => sender.sent.length > 0)
  t.alike(sender.sent.map(([c, d]) => [c, String(d)]), [['pear:worker:ipc:' + MAIN_WORKER_SPEC, '{"type":"event:x"}\n']])

  const write = electron.ipcMain.handlers.get('pear:worker:writeIPC:' + MAIN_WORKER_SPEC)
  t.is(write({ sender }, Buffer.from('{"id":1,"type":"ping"}\n')), true)
  await until(() => windowPeer.received.length > 0)
  t.alike(windowPeer.received, ['{"id":1,"type":"ping"}\n'])
  t.is(write({ sender: fakeSender(8) }, Buffer.from('x')), false, 'another window has no connection of its own yet')

  worker.emit('exit', 70)
  t.alike(sender.sent.filter(([c]) => c.startsWith('pear:worker:exit:')).map(([, code]) => code), [70])
})

test('a worker that exits before it listens fails the start, after the window heard the code', async (t) => {
  const { host, worker, electron } = load()
  host.registerWorkerHost()
  const sender = fakeSender(7)
  const starting = electron.ipcMain.handlers.get('pear:startWorker')({ sender }, MAIN_WORKER_SPEC)
  worker.emit('exit', 73)
  await t.exception(starting)
  t.alike(sender.sent.map(([c, code]) => [c, code]), [['pear:worker:exit:' + MAIN_WORKER_SPEC, 73]])
})

test('nothing the worker writes on the spawn pipe reaches a window', (t) => {
  const { host, worker, electron } = load()
  host.getWorker(MAIN_WORKER_SPEC)
  const view = { isDestroyed: () => false, sent: [], send(c, p) { this.sent.push([c, p]) } }
  electron.webContents.list.push(view)
  worker.emit('data', Buffer.from('{"type":"event:state"}\n'))
  t.alike(view.sent, [])
})
