import { spawn } from 'child_process'
import { createRequire } from 'module'
import net from 'net'
import path from 'path'
import { helloFrame } from './ipc-hello.js'

// A back end started the way a developer starts it: the worker entry run directly on the bare binary
// the desktop app ships (bare-sidecar's prebuild for this platform, as its own `#bare` import picks
// it), with no spawn pipe. Its stdout carries the timestamped log and one JSON line saying where the
// socket listens.
const require = createRequire(import.meta.url)
const WORKER_ENTRY = path.resolve('src/worker/main.js')

export function bareBinary() {
  const root = path.dirname(require.resolve('bare-sidecar'))
  const exe = process.platform === 'win32' ? 'bare.exe' : 'bare'
  return path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, exe)
}

const live = new Set()
let reaperInstalled = false
function installReaper() {
  if (reaperInstalled) return
  reaperInstalled = true
  process.on('exit', () => { for (const child of live) { try { child.kill('SIGKILL') } catch {} } })
}

// Resolves once the process exits, with its code (or the signal that ended it).
export function spawnHeadless(args, { env = {} } = {}) {
  installReaper()
  const child = spawn(bareBinary(), [WORKER_ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  live.add(child)
  const out = []
  const err = []
  const listeners = new Set()
  let listening = null
  let buf = ''
  child.stdout.on('data', (chunk) => {
    out.push(chunk)
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'main-request' && msg.command === 'socket:listening') {
        listening = msg.args.path
        for (const fn of listeners) fn(listening)
      }
    }
  })
  child.stderr.on('data', (chunk) => err.push(chunk))
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { live.delete(child); resolve(code ?? signal) }))
  return {
    child,
    exited,
    stdout: () => Buffer.concat(out).toString(),
    stderr: () => Buffer.concat(err).toString(),
    // The socket path, once the back end prints it; rejects if the process exits first.
    listening(ms) {
      if (listening) return Promise.resolve(listening)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no listening line within ${ms}ms\n${Buffer.concat(err).toString()}`)), ms)
        listeners.add((p) => { clearTimeout(timer); resolve(p) })
        exited.then((code) => { clearTimeout(timer); reject(new Error(`exited ${code} before listening\n${Buffer.concat(err).toString()}`)) })
      })
    },
  }
}

// A host client on the back end's socket, as a window or a CLI connects: it introduces itself,
// answers keepalives, and matches responses to requests by id.
export function connectClient(socketPath, { name = 'flow-headless' } = {}) {
  const socket = net.connect(socketPath)
  const pending = new Map()
  const frames = []
  let buf = ''
  let next = 0
  let closed = false
  socket.on('data', (chunk) => {
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.type === 'keepalive') { socket.write('{"type":"keepalive-ack"}\n'); continue }
      frames.push(msg)
      if (msg.type === 'response' && pending.has(msg.id)) {
        const settle = pending.get(msg.id)
        pending.delete(msg.id)
        settle(msg)
      }
    }
  })
  const gone = () => {
    closed = true
    for (const settle of pending.values()) settle({ type: 'response', error: 'socket closed', code: 'GONE' })
    pending.clear()
  }
  socket.on('error', () => {})
  socket.on('close', gone)
  socket.write(JSON.stringify(helloFrame({ client: { kind: 'test', name, version: '0.0.0-test' } })) + '\n')
  return {
    socket,
    frames,
    get closed() { return closed },
    of: (type) => frames.filter((f) => f.type === type),
    // The raw response frame: `data` on success, `error` and `code` on a refusal.
    call(type, args = {}) {
      if (closed) return Promise.resolve({ type: 'response', error: 'socket closed', code: 'GONE' })
      const id = 'h' + (next++)
      return new Promise((resolve) => {
        pending.set(id, resolve)
        socket.write(JSON.stringify({ id, type, ...args }) + '\n')
      })
    },
    writeRaw: (text) => socket.write(text),
    close: () => socket.destroy(),
  }
}
