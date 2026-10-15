'use strict'

// One connection to the worker's socket per window. Main moves a window's bytes in both directions
// and never reads or writes a frame of its own on it, so the worker sees each window as a client of
// its own: its own hello, request ids, subscriptions and in-flight work.
//
// A window learns its connection ended through the exit channel, exactly once per worker it started.
// When the worker process dies, the code it died with is what the window's respawn policy needs, and
// the socket usually closes a moment before the process is reported gone; a socket that closes
// while the process lives (the worker reaped a silent window) is reported as exit 0 after a grace
// period, unless the process exit arrived within it.

const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')

const EXIT_GRACE_MS = 1000

// Whoever can write the socket's directory can put their own socket in its place, so main talks to
// a socket only inside a directory that is this user's alone. A named pipe has no directory: the
// worker's bind of the first instance under an owner-only DACL is what makes its name ours.
function assertPrivateSocketDir(socketPath, platform = process.platform) {
  if (platform === 'win32') return
  const dir = path.dirname(socketPath)
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
    throw new Error('worker socket directory is not private to this user: ' + dir)
  }
}

function createWindowConnections({
  connect = (socketPath) => net.connect(socketPath),
  checkDir = assertPrivateSocketDir,
  graceMs = EXIT_GRACE_MS,
} = {}) {
  const windows = new Map()
  const watched = new Set()

  function notifyExit(entry, code) {
    if (entry.exited) return
    entry.exited = true
    if (!entry.sender.isDestroyed()) entry.sender.send('pear:worker:exit:' + entry.specifier, code)
  }

  function release(entry) {
    const socket = entry.socket
    if (!socket) return
    entry.socket = null
    socket.removeAllListeners('close')
    socket.destroy()
  }

  function forget(senderId) {
    const entry = windows.get(senderId)
    if (!entry) return
    entry.exited = true
    release(entry)
    windows.delete(senderId)
  }

  function onSocketClosed(entry, socket) {
    if (entry.socket !== socket) return
    entry.socket = null
    if (entry.exited) return
    setTimeout(() => notifyExit(entry, 0), graceMs).unref?.()
  }

  // The window now depends on this worker: from here its exit reaches the window, even one that
  // arrives before the socket is open. A reload keeps the window's id, and the old page's connection
  // goes without an exit the new page would read as its own.
  function claim(sender, specifier, worker) {
    forget(sender.id)
    windows.set(sender.id, { sender, specifier, worker, socket: null, exited: false })
    if (watched.has(sender.id)) return
    watched.add(sender.id)
    sender.once('destroyed', () => { watched.delete(sender.id); forget(sender.id) })
    sender.on('render-process-gone', () => forget(sender.id))
  }

  async function open(senderId, socketPath) {
    const entry = windows.get(senderId)
    if (!entry) throw new Error('no worker claimed for this window')
    checkDir(socketPath)
    const socket = connect(socketPath)
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    if (windows.get(senderId) !== entry || entry.exited) {
      socket.destroy()
      throw new Error('the worker went away while this window connected')
    }
    entry.socket = socket
    socket.on('error', () => {})
    socket.on('data', (data) => {
      if (!entry.sender.isDestroyed()) entry.sender.send('pear:worker:ipc:' + entry.specifier, data)
    })
    socket.on('close', () => onSocketClosed(entry, socket))
  }

  function write(senderId, data) {
    const socket = windows.get(senderId)?.socket
    if (!socket || socket.destroyed) return false
    socket.write(Buffer.from(data))
    return true
  }

  function workerOf(senderId) {
    const entry = windows.get(senderId)
    return entry && !entry.exited ? entry.worker : null
  }

  function workerExited(worker, code) {
    for (const entry of windows.values()) {
      if (entry.worker !== worker) continue
      notifyExit(entry, code)
      release(entry)
    }
  }

  return { claim, open, write, workerOf, workerExited }
}

module.exports = { createWindowConnections, assertPrivateSocketDir }
