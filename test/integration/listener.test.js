import test from 'brittle'
import EventEmitter from 'bare-events'
import Pipe from 'bare-pipe'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { createIPC } from '../../src/shared/core/ipc.js'
import { requireHost } from '../../src/shared/core/client-trust.js'
import { startListener, hasPeerCredentials } from '../../src/worker/listener.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../../src/shared/contract/main-requests.js'
import { FRAME, TRUST } from '../../src/shared/contract/ipc-frames.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { SUN_PATH_MAX } from '../../src/shared/core/socket-path.js'
import { sayHello, helloFrame } from '../helpers/ipc-hello.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { waitFor } from '../helpers/bare-poll.js'

const TEST_REQUESTS = Object.freeze({
  'ping': { kind: 'query', args: {} },
  'shutdown': { kind: 'command', args: {} },
  'slow': { kind: 'query', args: {} },
})

function hostPipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(String(s)); return true }
  ee.of = (type) => ee.written.flatMap((l) => l.split('\n')).filter(Boolean).map((l) => JSON.parse(l)).filter((f) => f.type === type)
  return ee
}

function quietLog() {
  const warned = []
  return { warned, info: () => {}, debug: () => {}, warn: (...a) => { warned.push(a.join(' ')) } }
}

async function serve(t, { storage, clock = null } = {}) {
  storage = storage || path.join(tmpDir('lsn', t), 'app-storage')
  const host = hostPipe()
  const ipc = createIPC(host, { requests: TEST_REQUESTS, ...(clock ? { now: () => clock.at } : {}) })
  sayHello(host)
  ipc.handle('ping', () => 'pong')
  ipc.handle('shutdown', (_msg, ctx) => { requireHost(ctx.client); return true })
  ipc.handle('slow', () => new Promise(() => {}))
  ipc.start()
  const log = quietLog()
  const listened = await startListener({ ipc, storage, log })
  if (listened.close) t.teardown(() => listened.close())
  return { ipc, host, listened, storage, log }
}

function connect(socketPath) {
  const pipe = Pipe.createConnection(socketPath)
  const frames = []
  let buf = ''
  let closed = false
  pipe.on('data', (chunk) => {
    buf += String(chunk)
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) if (line) frames.push(JSON.parse(line))
  })
  pipe.on('error', () => {})
  pipe.on('end', () => { closed = true })
  pipe.on('close', () => { closed = true })
  return {
    pipe,
    frames,
    get closed() { return closed },
    send: (obj) => pipe.write(JSON.stringify(obj) + '\n'),
    of: (type) => frames.filter((f) => f.type === type),
    response: (id) => frames.find((f) => f.id === id && f.type === 'response'),
  }
}

async function greeted(socketPath) {
  const client = connect(socketPath)
  client.send(helloFrame())
  await waitFor(() => client.of(FRAME.HELLO_ACK).length === 1, 2000, { label: 'hello-ack' })
  return client
}

test('bare-pipe carries peer credentials and owner-only listen', async (t) => {
  t.ok(hasPeerCredentials(), 'remoteCredentials exists, so the installed bare-pipe is at least 4.4.0')
  const { listened } = await serve(t)
  t.is(listened.verdict, 'listening', 'and a listen with ownerOnly binds')
})

test('the socket and its directory are private, and only the host hears where it is', async (t) => {
  const { listened, host } = await serve(t)
  t.is(fs.statSync(listened.path).mode & 0o777, 0o600, 'the socket is 0600')
  t.is(fs.statSync(path.dirname(listened.path)).mode & 0o777, 0o700, 'its directory is 0700')
  const announced = host.of(MAIN_REQUEST_FRAME).filter((f) => f.command === MAIN_REQUEST.SOCKET_LISTENING)
  t.alike(announced.map((f) => f.args.path), [listened.path], 'the path goes to the host, once')

  const client = await greeted(listened.path)
  t.is(client.of(MAIN_REQUEST_FRAME).length, 0, 'a socket client never sees a main-request')
  client.pipe.destroy()
})

test('a connection of the owning user is the host, and may ask for host-only work', async (t) => {
  const { listened } = await serve(t)
  const client = await greeted(listened.path)
  t.is(client.of(FRAME.HELLO_ACK)[0].trust, TRUST.HOST)
  t.is(client.pipe.remoteCredentials().uid, os.userInfo().uid, 'the server end belongs to this user')

  client.send({ id: 1, type: 'shutdown' })
  await waitFor(() => client.response(1), 2000, { label: 'shutdown answer' })
  t.is(client.response(1).data, true, 'requireHost lets it through')
  client.pipe.destroy()
})

test('two socket clients with the same request id each get their own answer', async (t) => {
  const { listened, ipc } = await serve(t)
  const a = await greeted(listened.path)
  const b = await greeted(listened.path)
  a.send({ id: 1, type: 'ping' })
  b.send({ id: 1, type: 'ping' })
  await waitFor(() => a.response(1) && b.response(1), 2000, { label: 'both answers' })
  t.is(a.frames.filter((f) => f.type === 'response').length, 1)
  t.is(b.frames.filter((f) => f.type === 'response').length, 1)

  ipc.emit('event:audit-updated', {})
  await waitFor(() => a.of('event:audit-updated').length && b.of('event:audit-updated').length, 2000, { label: 'event fan-out' })
  t.pass('an event reaches every socket client')
  a.pipe.destroy()
  b.pipe.destroy()
})

test('a socket client is refused before its hello, and cannot bootstrap', async (t) => {
  const { listened, host } = await serve(t)
  const client = connect(listened.path)
  client.send({ id: 1, type: 'ping' })
  await waitFor(() => client.response(1), 2000, { label: 'refusal' })
  t.is(client.response(1).code, CODES.NOT_AUTHORIZED)

  client.send(helloFrame())
  client.send({ type: FRAME.BOOTSTRAP, storage: '/elsewhere' })
  client.send({ id: 2, type: 'ping' })
  await waitFor(() => client.response(2), 2000, { label: 'ping after hello' })
  t.is(client.response(2).data, 'pong', 'the client keeps working')
  t.is(host.of(FRAME.BOOTSTRAP).length, 0, 'and the bootstrap went nowhere')
  client.pipe.destroy()
})

test('a socket file left by a killed worker is replaced', async (t) => {
  const dir = tmpDir('lsn', t)
  const storage = path.join(dir, 'app-storage')
  const runDir = path.join(dir, 'run')
  fs.mkdirSync(runDir, { mode: 0o700 })
  const target = path.join(runDir, 'daemon.sock')
  // A socket with nobody behind it: bound elsewhere, moved into place, and its server closed, so the
  // close unlinks the old name and the file at the target is left exactly as a SIGKILL leaves one.
  const elsewhere = path.join(runDir, 'x.sock')
  const ghost = Pipe.createServer()
  await new Promise((resolve) => ghost.listen(elsewhere, resolve))
  fs.renameSync(elsewhere, target)
  await new Promise((resolve) => ghost.close(resolve))
  t.ok(fs.existsSync(target), 'the stale file is in place')

  const { listened } = await serve(t, { storage })
  t.is(listened.verdict, 'listening')
  const client = await greeted(listened.path)
  t.pass('and the replacement answers')
  client.pipe.destroy()
})

test('a live listener on the path that does not hold the lock is not displaced', async (t) => {
  const dir = tmpDir('lsn', t)
  const storage = path.join(dir, 'app-storage')
  fs.mkdirSync(path.join(dir, 'run'), { mode: 0o700 })
  const target = path.join(dir, 'run', 'daemon.sock')
  const squatter = Pipe.createServer((c) => c.destroy())
  await new Promise((resolve) => squatter.listen(target, resolve))

  const { listened } = await serve(t, { storage })
  t.is(listened.verdict, 'already-running')
  t.ok(fs.existsSync(target), 'the holder keeps its socket')

  await new Promise((resolve) => squatter.close(resolve))
  const again = await serve(t, { storage })
  t.is(again.listened.verdict, 'listening', 'and the lock was released with the refusal')
})

test('a second worker on the same profile is refused while the first keeps serving', async (t) => {
  const first = await serve(t)
  const second = await serve(t, { storage: first.storage })
  t.is(second.listened.verdict, 'already-running')
  t.is(second.host.of(MAIN_REQUEST_FRAME).length, 0, 'it announces nothing')

  const client = await greeted(first.listened.path)
  client.send({ id: 1, type: 'ping' })
  await waitFor(() => client.response(1), 2000, { label: 'first still answers' })
  t.is(client.response(1).data, 'pong')
  client.pipe.destroy()
})

test('a run directory that is not private refuses to listen', async (t) => {
  const linked = tmpDir('listener-link', t)
  const target = tmpDir('listener-link-target', t)
  fs.chmodSync(target, 0o700)
  fs.symlinkSync(target, path.join(linked, 'run'))
  const viaLink = await serve(t, { storage: path.join(linked, 'app-storage') })
  t.is(viaLink.listened.verdict, 'failed', 'a symlink is refused')

  const open = tmpDir('listener-open', t)
  fs.mkdirSync(path.join(open, 'run'))
  fs.chmodSync(path.join(open, 'run'), 0o755)
  const wide = await serve(t, { storage: path.join(open, 'app-storage') })
  t.is(wide.listened.verdict, 'failed', 'so is a directory others can read')
})

test('a data directory too deep for a socket path listens under the temp root', async (t) => {
  let deep = tmpDir('listener-deep', t)
  while (deep.length <= SUN_PATH_MAX) deep = path.join(deep, 'nested-directory')
  fs.mkdirSync(deep, { recursive: true })
  const { listened } = await serve(t, { storage: path.join(deep, 'app-storage') })
  t.is(listened.verdict, 'listening')
  t.ok(listened.path.startsWith(path.join(os.tmpdir(), 'mirall-' + os.userInfo().uid)), listened.path)
  t.is(fs.statSync(path.dirname(listened.path)).mode & 0o777, 0o700)
  const client = await greeted(listened.path)
  client.pipe.destroy()
})

test('a detached client loses its socket', async (t) => {
  const { listened, ipc } = await serve(t)
  const client = await greeted(listened.path)
  const attached = await waitFor(() => ipc.clientCount() === 2, 2000, { label: 'attach' })
  t.ok(attached)
  client.send({ id: 1, type: 'slow' })
  await waitFor(() => ipc.inFlightCount() === 1, 2000, { label: 'in flight' })
  ipc.sweepLiveness({ keepaliveMs: 0, graceMs: 0 })
  ipc.sweepLiveness({ keepaliveMs: 0, graceMs: 0 })
  await waitFor(() => client.closed, 2000, { label: 'socket closed' })
  t.is(ipc.inFlightCount(), 0, 'its work is aborted')
})

test('a quiet client is asked, an answering one stays, a silent one is reaped', async (t) => {
  const clock = { at: 1000 }
  const { listened, ipc } = await serve(t, { clock })
  const answering = await greeted(listened.path)
  const silent = await greeted(listened.path)
  const busy = await greeted(listened.path)
  const timing = { keepaliveMs: 30000, graceMs: 10000 }

  clock.at += 30000
  busy.send({ id: 1, type: 'ping' })
  await waitFor(() => busy.response(1), 2000, { label: 'busy ping' })
  ipc.sweepLiveness(timing)
  await waitFor(() => answering.of(FRAME.KEEPALIVE).length && silent.of(FRAME.KEEPALIVE).length, 2000, { label: 'keepalives' })
  t.is(busy.of(FRAME.KEEPALIVE).length, 0, 'a client that just spoke is not asked')

  answering.send({ type: FRAME.KEEPALIVE_ACK })
  answering.send({ id: 1, type: 'ping' })
  await waitFor(() => answering.response(1), 2000, { label: 'ack landed' })
  clock.at += 10000
  ipc.sweepLiveness(timing)
  await waitFor(() => silent.closed, 2000, { label: 'silent reaped' })
  t.absent(answering.closed, 'the answering client stays')
  t.absent(busy.closed, 'and so does the busy one')
  answering.pipe.destroy()
  busy.pipe.destroy()
})

test('closing the listener removes the socket and frees the profile', async (t) => {
  const { listened, storage } = await serve(t)
  const client = await greeted(listened.path)
  await listened.close()
  t.absent(fs.existsSync(listened.path), 'the socket file is gone')
  await waitFor(() => client.closed, 2000, { label: 'client closed' })
  const again = await serve(t, { storage })
  t.is(again.listened.verdict, 'listening', 'and the lock can be taken again')
})
