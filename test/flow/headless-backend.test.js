import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnHeadless, connectClient } from '../helpers/headless.js'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace, waitForCatalogEntry } from '../helpers/peer.js'
import { tmpDir } from '../helpers/tmp.js'
import { scaled } from '../helpers/timing.js'

const WORKER_EXIT_PROTOCOL_MISMATCH = 71
const WORKER_EXIT_ALREADY_RUNNING = 73

function dataDir(t) {
  return path.join(tmpDir('mirall-headless', t), 'profile')
}

test('a command line the back end cannot read is refused with its usage', { timeout: scaled(20000) }, async (t) => {
  const run = spawnHeadless(['--storage', dataDir(t), '--bogus'])
  t.is(await run.exited, WORKER_EXIT_PROTOCOL_MISMATCH, 'refused like a host on another protocol')
  t.ok(run.stderr().includes('unknown_flag: bogus'), 'says which argument')
  t.ok(run.stderr().includes('usage: bare src/worker/main.js'), 'and how to call it')

  const lever = spawnHeadless(['--storage', dataDir(t), '--dht-bootstrap', '127.0.0.1:1'])
  t.is(await lever.exited, WORKER_EXIT_PROTOCOL_MISMATCH, 'a test lever without --dev is refused')
})

test('started without a pipe, the back end listens beside its own store and says where', { timeout: scaled(30000) }, async (t) => {
  const dir = dataDir(t)
  const run = spawnHeadless(['--storage', dir, '--dev'])
  t.teardown(() => { run.child.kill('SIGKILL') })
  const socket = await run.listening(scaled(20000))
  t.ok(fs.existsSync(path.join(dir, 'run', 'daemon.lock')), 'the profile lock of the data folder it was given')
  t.ok(fs.statSync(socket).isSocket(), 'and the socket it names is bound')
  if (process.platform !== 'win32') {
    t.is(fs.statSync(path.join(dir, 'app-storage')).mode & 0o777, 0o700, 'the store it created is the owner\'s alone')
  }
  const second = spawnHeadless(['--storage', dir, '--dev'])
  t.is(await second.exited, WORKER_EXIT_ALREADY_RUNNING, 'a second start on the same profile says it is already running')
})

const kekHex = () => crypto.randomBytes(32).toString('hex')
const keyForms = (hex) => {
  const raw = Buffer.from(hex, 'hex')
  return { hex, base64: raw.toString('base64'), bytes: raw.toString('latin1') }
}

// The process's own stdout and stderr, at the most verbose level, across every path a key takes:
// a frame that is not JSON, a key of the wrong length, a wrong key, and the right one.
test('a back end waits for its key, unlocks over the socket, and never prints a key', { timeout: scaled(90000) }, async (t) => {
  const dir = dataDir(t)
  const kek = kekHex()
  const wrong = kekHex()
  const first = spawnHeadless(['--storage', dir, '--dev', '--verbose'])
  t.teardown(() => { first.child.kill('SIGKILL') })
  const a = connectClient(await first.listening(scaled(20000)))
  t.alike((await a.call('identity:status')).data, { locked: true, code: 'IDENTITY_AWAITING_KEY', restore: null }, 'waiting, and says why')
  t.is((await a.call('spaces:list')).code, 'NOT_FOUND', 'the data layer is not served before the key')
  a.writeRaw(kek + '\n')
  t.is((await a.call('identity:unlock', { kek: kek.slice(1) })).code, 'INVALID_ARGUMENT', 'a key of the wrong length')
  t.alike((await a.call('identity:unlock', { kek })).data, { ok: true }, 'the key boots it in place')
  t.alike((await a.call('identity:status')).data, { locked: false, code: null, restore: null })
  t.ok(Array.isArray((await a.call('spaces:list')).data), 'and the data layer answers')
  t.is((await a.call('identity:unlock', { kek })).code, 'NOT_AUTHORIZED', 'a second unlock is refused')
  t.ok(a.of('event:worker-ready').length >= 2, 'told it was up while waiting, and again once booted')
  a.close()
  first.child.kill('SIGKILL')
  await first.exited

  const second = spawnHeadless(['--storage', dir, '--dev', '--verbose'])
  t.teardown(() => { second.child.kill('SIGKILL') })
  const b = connectClient(await second.listening(scaled(20000)))
  t.is((await b.call('identity:unlock', { kek: wrong })).code, 'IDENTITY_UNLOCK_FAILED', 'a wrong key is refused')
  t.is((await b.call('identity:status')).data.code, 'IDENTITY_AWAITING_KEY', 'and the worker keeps waiting')
  t.alike((await b.call('identity:unlock', { kek })).data, { ok: true }, 'the right one, no restart')
  b.close()

  const printed = first.stdout() + first.stderr() + second.stdout() + second.stderr()
  t.ok(printed.includes('identity:unlock'), 'the requests were logged')
  for (const key of [kek, wrong]) {
    for (const [form, text] of Object.entries(keyForms(key))) t.absent(printed.includes(text.slice(0, 12)), `no ${form} form of a key`)
  }
})

// A service manager's stop and a terminal's Ctrl+C: the same teardown a shutdown request runs, a
// clean exit, the profile lock released and the socket file gone.
test('SIGTERM and SIGINT stop a back end cleanly, waiting or unlocked', { skip: process.platform === 'win32', timeout: scaled(90000) }, async (t) => {
  const dir = dataDir(t)
  const kek = kekHex()
  const stops = [['SIGTERM', null], ['SIGINT', kek], ['SIGTERM', kek]]
  for (const [signal, key] of stops) {
    const run = spawnHeadless(['--storage', dir, '--dev'])
    t.teardown(() => { run.child.kill('SIGKILL') })
    const socket = await run.listening(scaled(20000))
    if (key) {
      const client = connectClient(socket)
      t.alike((await client.call('identity:unlock', { kek: key })).data, { ok: true })
      client.close()
    }
    run.child.kill(signal)
    t.is(await run.exited, 0, `${signal} ${key ? 'after the unlock' : 'while waiting'} exits 0`)
    t.absent(fs.existsSync(socket), 'and leaves no socket file')
  }
  const again = spawnHeadless(['--storage', dir, '--dev'])
  t.teardown(() => { again.child.kill('SIGKILL') })
  t.ok(await again.listening(scaled(20000)), 'the lock was released: the next start takes it')
  again.child.kill('SIGTERM')
  t.is(await again.exited, 0)
})

// Two back ends with no window between them, each unlocked by the harness over its socket: they
// share a space and a file's listing, and one keeps running after its last client has gone.
test('headless back ends share a space, and one outlives its last client', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', transport: 'headless' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', transport: 'headless' })
  t.alike(await A.request('identity:status'), { locked: false, code: null, restore: null }, 'unlocked by the harness')
  const spaceId = await connectInSpace(t, A, B)

  const src = path.join(tmpDir('mirall-headless-src', t), 'note.txt')
  fs.writeFileSync(src, 'a small file')
  await A.request('files:add', { spaceId, filePath: src, fileName: 'note.txt', fileSize: fs.statSync(src).size })
  const entry = await waitForCatalogEntry(B, spaceId, '/note.txt')
  t.is(entry.status, 'remote', 'Bob lists the file Alice shared')

  const child = A.sidecar._process
  const socket = A.socketPath()
  A.disconnect()
  await new Promise((resolve) => setTimeout(resolve, scaled(1500)))
  t.is(child.exitCode, null, 'the back end is still running with no client attached')

  const again = connectClient(socket)
  const spaces = (await again.call('spaces:list')).data
  t.ok(spaces.some((s) => s.spaceId === spaceId), 'a new client reads the space it left behind')
  again.close()

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  child.kill('SIGTERM')
  t.is(await exited, 0, 'and it stops cleanly when told to')
})
