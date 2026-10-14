// The worker's local socket: every window, and any other client of this profile, reaches the worker
// here as a connection of its own. The spawn pipe stays the host's — the bootstrap and the worker's
// commands to main travel there only.
//
// Order is the interlock: the profile lock first, so two workers never race for one store; then the
// bind, where a socket file left by a killed worker is told from a live listener by connecting to
// it; then the announcement to main, which never computes the path itself. Admission is bare-pipe's
// ownerOnly (a 0600 socket, other users dropped at accept) plus admitPeer's stricter check, and an
// admitted connection is the host: it is the owning user on this machine.
import Pipe from 'bare-pipe'
import FDLock from 'fd-lock'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { TRUST } from '../shared/contract/ipc-frames.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../shared/contract/main-requests.js'
import { socketPaths } from '../shared/core/socket-path.js'
import { admitPeer } from '../shared/core/peer-admission.js'

export function hasPeerCredentials() {
  return typeof Pipe.prototype.remoteCredentials === 'function'
}

export async function startListener({ ipc, storage, log }) {
  if (!hasPeerCredentials()) return { verdict: 'failed', reason: 'bare-pipe reports no peer credentials' }
  const platform = os.platform()
  const uid = platform === 'win32' ? -1 : os.userInfo().uid
  const paths = socketPaths({
    platform,
    dataDir: path.dirname(storage),
    storageHash: b4a.toString(crypto.hash(b4a.from(storage)), 'hex'),
    uid,
    tmpdir: os.tmpdir(),
  })
  try {
    ensurePrivateDir(paths.runDir, { platform, uid })
    if (paths.socketDir && paths.socketDir !== paths.runDir) ensurePrivateDir(paths.socketDir, { platform, uid })
  } catch (err) {
    return { verdict: 'failed', reason: err.message }
  }

  const lock = await takeLock(paths.lock)
  if (!lock) return { verdict: 'already-running', reason: 'another worker holds ' + paths.lock }

  const bound = await bind(paths.socket, platform)
  if (!bound.server) {
    await lock.close()
    return { verdict: bound.verdict, reason: bound.reason }
  }
  const server = bound.server
  server.on('error', (err) => { log.warn('listener error:', err.message) })

  const sockets = new Map()
  const refused = new Set()
  server.on('connection', (pipe) => {
    const verdict = admitPeer(readCredentials(pipe), { platform, uid })
    if (!verdict.ok) {
      if (!refused.has(verdict.reason)) {
        refused.add(verdict.reason)
        log.warn('listener: refused a connection:', verdict.reason)
      }
      pipe.destroy()
      return
    }
    const client = ipc.attach(pipe, { trust: TRUST.HOST })
    sockets.set(client, pipe)
    const gone = (reason) => { ipc.detach(client, reason) }
    pipe.on('end', () => gone('socket-end'))
    pipe.on('close', () => gone('socket-close'))
    pipe.on('error', (err) => gone('socket-error: ' + err.message))
  })
  // The router only marks a detached client closed; the socket is the listener's to end.
  ipc.onClientDisconnect((client) => {
    const pipe = sockets.get(client)
    if (!pipe) return
    sockets.delete(client)
    pipe.destroy()
  })

  ipc.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.SOCKET_LISTENING, args: { path: paths.socket } })
  log.info('listening on', paths.socket)

  let closing = null
  function close() {
    closing ??= (async () => {
      for (const pipe of sockets.values()) pipe.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(resolve))
      await lock.close()
    })()
    return closing
  }

  return { verdict: 'listening', path: paths.socket, close }
}

// A directory the socket or lock lives in must be this user's alone: whoever can write it can
// replace the socket with their own.
function ensurePrivateDir(dir, { platform, uid }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (platform === 'win32') return
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error('not a private directory: ' + dir)
  }
}

async function takeLock(file) {
  const lock = new FDLock(fs.openSync(file, 'a+', 0o600))
  try {
    await lock.ready()
    return lock
  } catch {
    return null
  }
}

// Read first thing: the call throws once the peer has gone, and on macOS the pid is gone with it.
function readCredentials(pipe) {
  try { return pipe.remoteCredentials() } catch { return null }
}

function listenOnce(socketPath) {
  return new Promise((resolve) => {
    const server = Pipe.createServer()
    const onError = (err) => resolve({ server: null, code: err.code, message: err.message })
    server.once('error', onError)
    server.listen({ path: socketPath, ownerOnly: true }, () => {
      server.removeListener('error', onError)
      resolve({ server, code: null, message: null })
    })
  })
}

// A socket file outlives only a killed worker. Whether one is stale is asked of the socket itself:
// a refused connection means nobody listens, anything else means somebody does.
function probe(socketPath) {
  return new Promise((resolve) => {
    const client = Pipe.createConnection(socketPath)
    client.on('error', () => {})
    client.once('connect', () => { client.destroy(); resolve('live') })
    client.once('error', (err) => resolve(err.code === 'ECONNREFUSED' || err.code === 'ENOENT' ? 'stale' : 'live'))
  })
}

async function bind(socketPath, platform) {
  const first = await listenOnce(socketPath)
  if (first.server) return { server: first.server }
  if (first.code !== 'EADDRINUSE') return { server: null, verdict: 'failed', reason: first.code + ': ' + first.message }
  // A named pipe leaves nothing behind, so a taken name is a live holder while we hold the lock.
  if (platform === 'win32') return { server: null, verdict: 'already-running', reason: 'another process holds ' + socketPath }
  if (await probe(socketPath) === 'live') return { server: null, verdict: 'already-running', reason: 'another process listens on ' + socketPath }
  fs.unlinkSync(socketPath)
  const second = await listenOnce(socketPath)
  if (second.server) return { server: second.server }
  return { server: null, verdict: 'failed', reason: second.code + ': ' + second.message }
}
