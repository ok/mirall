import test from 'brittle'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { tmpDir } from '../helpers/tmp.js'

const require = createRequire(import.meta.url)
const { createWindowConnections, assertPrivateSocketDir } = require('../../src/main/window-connections.js')

const SPEC = '/src/worker/main.js'

function fakeSender(id) {
  const ee = new EventEmitter()
  ee.id = id
  ee.sent = []
  ee.gone = false
  ee.isDestroyed = () => ee.gone
  ee.send = (channel, payload) => { ee.sent.push([channel, payload]) }
  ee.exits = () => ee.sent.filter(([c]) => c === 'pear:worker:exit:' + SPEC).map(([, code]) => code)
  ee.data = () => ee.sent.filter(([c]) => c === 'pear:worker:ipc:' + SPEC).map(([, d]) => String(d))
  return ee
}

function fakeSocket() {
  const ee = new EventEmitter()
  ee.written = []
  ee.destroyed = false
  ee.write = (b) => { ee.written.push(String(b)) }
  ee.destroy = () => { if (ee.destroyed) return; ee.destroyed = true; ee.emit('close') }
  setImmediate(() => ee.emit('connect'))
  return ee
}

function connections({ graceMs = 5 } = {}) {
  const sockets = []
  const conns = createWindowConnections({
    connect: () => { const s = fakeSocket(); sockets.push(s); return s },
    checkDir: () => {},
    graceMs,
  })
  return { conns, sockets }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('each window gets its own connection, and only its own bytes', async (t) => {
  const { conns, sockets } = connections()
  const worker = {}
  const a = fakeSender(1)
  const b = fakeSender(2)
  conns.claim(a, SPEC, worker)
  conns.claim(b, SPEC, worker)
  await conns.open(1, '/run/daemon.sock')
  await conns.open(2, '/run/daemon.sock')
  t.is(sockets.length, 2)

  sockets[0].emit('data', Buffer.from('for-a\n'))
  t.alike(a.data(), ['for-a\n'])
  t.alike(b.data(), [], 'nothing crosses to the other window')

  t.is(conns.write(2, Buffer.from('from-b\n')), true)
  t.alike(sockets[1].written, ['from-b\n'])
  t.alike(sockets[0].written, [])
})

test('a window with no connection is told its write went nowhere', (t) => {
  const { conns } = connections()
  t.is(conns.write(9, Buffer.from('x')), false)
})

test('a worker exit reaches each of its windows once, with the code, even before they connected', async (t) => {
  const { conns, sockets } = connections()
  const worker = {}
  const connected = fakeSender(1)
  const waiting = fakeSender(2)
  conns.claim(connected, SPEC, worker)
  conns.claim(waiting, SPEC, worker)
  await conns.open(1, '/run/daemon.sock')

  sockets[0].destroy()
  conns.workerExited(worker, 73)
  await wait(20)
  t.alike(connected.exits(), [73], 'the code, not the socket close that came first')
  t.alike(waiting.exits(), [73], 'a window still waiting for the socket learns the same')
  conns.workerExited(worker, 0)
  t.alike(connected.exits(), [73], 'and never twice for one worker')
})

test('a socket the worker closed while it lives reads as exit 0 after the grace', async (t) => {
  const { conns, sockets } = connections()
  const sender = fakeSender(1)
  conns.claim(sender, SPEC, {})
  await conns.open(1, '/run/daemon.sock')
  sockets[0].destroy()
  t.alike(sender.exits(), [], 'not at once: the process exit may still be coming')
  await wait(20)
  t.alike(sender.exits(), [0])
  t.is(conns.write(1, Buffer.from('x')), false)
})

test('a reload drops the old page\'s connection without an exit for the new page', async (t) => {
  const { conns, sockets } = connections()
  const sender = fakeSender(1)
  const worker = {}
  conns.claim(sender, SPEC, worker)
  await conns.open(1, '/run/daemon.sock')
  conns.claim(sender, SPEC, worker)
  t.ok(sockets[0].destroyed, 'the old connection is closed')
  await conns.open(1, '/run/daemon.sock')
  await wait(20)
  t.alike(sender.exits(), [], 'and the new page hears nothing about it')
  t.is(conns.write(1, Buffer.from('x')), true, 'the new connection carries its writes')
})

test('a destroyed or crashed window closes its connection', async (t) => {
  const { conns, sockets } = connections()
  const closed = fakeSender(1)
  const crashed = fakeSender(2)
  conns.claim(closed, SPEC, {})
  conns.claim(crashed, SPEC, {})
  await conns.open(1, '/run/daemon.sock')
  await conns.open(2, '/run/daemon.sock')
  closed.gone = true
  closed.emit('destroyed')
  crashed.emit('render-process-gone')
  t.ok(sockets[0].destroyed && sockets[1].destroyed)
  await wait(20)
  t.alike(crashed.exits(), [], 'a renderer that is gone is not sent an exit')
})

test('a window that loses its worker while connecting is not left with a connection', async (t) => {
  const { conns, sockets } = connections()
  const sender = fakeSender(1)
  const worker = {}
  conns.claim(sender, SPEC, worker)
  const opening = conns.open(1, '/run/daemon.sock')
  conns.workerExited(worker, 1)
  await t.exception(opening)
  t.ok(sockets[0].destroyed)
})

test('main talks only to a socket in a directory private to this user', (t) => {
  const dir = tmpDir('wc', t)
  const run = path.join(dir, 'run')
  fs.mkdirSync(run, { mode: 0o700 })
  t.execution(() => assertPrivateSocketDir(path.join(run, 'daemon.sock'), 'darwin'))

  fs.chmodSync(run, 0o755)
  t.exception(() => assertPrivateSocketDir(path.join(run, 'daemon.sock'), 'darwin'), 'others may read it')

  const target = path.join(dir, 'target')
  fs.mkdirSync(target, { mode: 0o700 })
  const link = path.join(dir, 'link')
  fs.symlinkSync(target, link)
  t.exception(() => assertPrivateSocketDir(path.join(link, 'daemon.sock'), 'darwin'), 'a symlink is not the directory')

  t.execution(() => assertPrivateSocketDir('\\\\.\\pipe\\mirall-x', 'win32'), 'a named pipe has no directory to check')
})
