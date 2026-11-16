import test from 'brittle'
import { EventEmitter } from 'events'
import net from 'net'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { tmpDir } from '../helpers/tmp.js'
import { IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED, CLIENT_KINDS } from '../../src/shared/contract/ipc-frames.js'

const require = createRequire(import.meta.url)
const { requestOverSocket } = require('../../src/main/worker-request.js')

const KEK = 'ab'.repeat(32)

// A socket the test drives by hand: what the client writes lands in `written`, and the test plays
// the worker by emitting data.
function fakeSocket({ connects = true } = {}) {
  const ee = new EventEmitter()
  ee.written = []
  ee.destroyed = false
  ee.write = (data) => { ee.written.push(String(data)) }
  ee.destroy = () => { if (ee.destroyed) return; ee.destroyed = true; ee.emit('close') }
  ee.frames = () => ee.written.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  if (connects) setImmediate(() => ee.emit('connect'))
  return ee
}

function request(socket, { type = 'identity:unlock', args = { kek: KEK }, ...options } = {}) {
  return requestOverSocket('/run/mirall/worker.sock', type, args, { connect: () => socket, checkDir: () => {}, ...options })
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the client introduces itself, sends one request and resolves with its data', async (t) => {
  const socket = fakeSocket()
  const answer = request(socket)
  await tick()
  await tick()
  const [hello, req] = socket.frames()
  t.is(hello.type, 'hello')
  t.is(hello.protocolVersion, IPC_PROTOCOL_VERSION)
  t.is(hello.protocolMin, IPC_PROTOCOL_MIN_SUPPORTED)
  t.ok(CLIENT_KINDS.includes(hello.client.kind), 'a kind the worker accepts')
  t.is(hello.client.kind, 'electron-main')
  t.is(req.type, 'identity:unlock')
  t.is(req.kek, KEK)

  socket.emit('data', Buffer.from(JSON.stringify({ type: 'event:worker-ready', epoch: 'e', head: 0 }) + '\n'))
  socket.emit('data', Buffer.from(JSON.stringify({ id: 'someone-else', type: 'response', data: 1 }) + '\n'))
  socket.emit('data', Buffer.from(JSON.stringify({ id: req.id, type: 'response', data: { ok: true } }) + '\n'))
  t.alike(await answer, { ok: true })
  t.ok(socket.destroyed, 'and hangs up')
})

test('a response split across chunks, multi-byte text included, is read whole', async (t) => {
  const socket = fakeSocket()
  const answer = request(socket)
  await tick()
  await tick()
  const [, req] = socket.frames()
  const bytes = Buffer.from(JSON.stringify({ id: req.id, type: 'response', data: { name: 'Zoë' } }) + '\n')
  const cut = bytes.indexOf(Buffer.from('ë')) + 1
  socket.emit('data', bytes.subarray(0, cut))
  socket.emit('data', bytes.subarray(cut))
  t.alike(await answer, { name: 'Zoë' })
})

test('the worker\'s keepalive is answered while the request is open', async (t) => {
  const socket = fakeSocket()
  const answer = request(socket)
  await tick()
  await tick()
  socket.emit('data', Buffer.from('{"type":"keepalive"}\n'))
  t.alike(socket.frames().filter((f) => f.type === 'keepalive-ack'), [{ type: 'keepalive-ack' }])
  const [, req] = socket.frames()
  socket.emit('data', Buffer.from(JSON.stringify({ id: req.id, type: 'response', data: null }) + '\n'))
  await answer
})

test('a refusal keeps the worker\'s code and sentence', async (t) => {
  const socket = fakeSocket()
  const answer = request(socket)
  await tick()
  await tick()
  const [, req] = socket.frames()
  socket.emit('data', Buffer.from(JSON.stringify({ id: req.id, type: 'response', error: 'identity unlock failed', code: 'IDENTITY_UNLOCK_FAILED' }) + '\n'))
  const err = await answer.then(() => null, (e) => e)
  t.is(err.code, 'IDENTITY_UNLOCK_FAILED')
  t.is(err.message, 'identity unlock failed')
  t.ok(socket.destroyed)
})

test('the reply has no deadline: a slow boot is waited out', async (t) => {
  const socket = fakeSocket()
  let settled = false
  const answer = request(socket, { connectTimeoutMs: 5 }).then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 40))
  t.absent(settled, 'well past the connection timeout, still waiting')
  const [, req] = socket.frames()
  socket.emit('data', Buffer.from(JSON.stringify({ id: req.id, type: 'response', data: { ok: true } }) + '\n'))
  await answer
  t.ok(settled)
})

test('a connection that closes before the answer fails without the payload in the error', async (t) => {
  const socket = fakeSocket()
  const answer = request(socket)
  await tick()
  await tick()
  socket.destroy()
  const err = await answer.then(() => null, (e) => e)
  t.ok(err)
  t.absent(err.code, 'no worker code: the worker did not answer')
  t.absent(err.message.includes(KEK))
})

test('a socket error fails the request and never echoes what was sent', async (t) => {
  const socket = fakeSocket()
  const answer = request(socket)
  await tick()
  socket.emit('error', Object.assign(new Error('connect ECONNREFUSED ' + KEK), { code: 'ECONNREFUSED' }))
  const err = await answer.then(() => null, (e) => e)
  t.absent(String(err.message).includes(KEK))
  t.absent(err.code, 'a connection fault is not a worker refusal')
})

test('a socket that never connects fails after the connection timeout', async (t) => {
  const socket = fakeSocket({ connects: false })
  const err = await request(socket, { connectTimeoutMs: 10 }).then(() => null, (e) => e)
  t.ok(err)
  t.ok(socket.destroyed)
  t.alike(socket.frames(), [], 'nothing was sent')
})

test('a directory that is not private is refused before any connection is made', async (t) => {
  let connected = false
  const err = await requestOverSocket('/tmp/shared/worker.sock', 'identity:unlock', { kek: KEK }, {
    checkDir: () => { throw new Error('worker socket directory is not private to this user: /tmp/shared') },
    connect: () => { connected = true },
  }).then(() => null, (e) => e)
  t.ok(err)
  t.absent(connected)
})

test('the default directory check is the one a window\'s connection applies', async (t) => {
  const dir = tmpDir('wr', t)
  const open = path.join(dir, 'open')
  fs.mkdirSync(open)
  fs.chmodSync(open, 0o755)
  const err = await requestOverSocket(path.join(open, 's.sock'), 'identity:status').then(() => null, (e) => e)
  t.ok(err && /not private/.test(err.message))
})

test('over a real socket, the request reaches a worker and its answer comes back', async (t) => {
  const dir = path.join(tmpDir('wr', t), 'run')
  fs.mkdirSync(dir, { mode: 0o700 })
  const seen = []
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const frame = JSON.parse(line)
        seen.push(frame)
        if (frame.id) sock.write(JSON.stringify({ id: frame.id, type: 'response', data: { ok: true } }) + '\n')
      }
    })
    sock.on('error', () => {})
  })
  const socketPath = path.join(dir, 's.sock')
  await new Promise((resolve) => server.listen(socketPath, resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  t.alike(await requestOverSocket(socketPath, 'identity:unlock', { kek: KEK }), { ok: true })
  t.is(seen[0].type, 'hello')
  t.is(seen[1].kek, KEK)
})
