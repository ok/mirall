'use strict'

// One request from main to a worker, over the worker's own socket: main connects as a client of its
// own, says hello, sends the request, takes its answer and hangs up. The spawn pipe stays the host's
// frames alone, and a window's connection stays a relay main never writes on.
//
// The request and its answer may carry a secret, so nothing here logs, echoes or puts either in an
// error: a refusal keeps the worker's own code and sentence, and every failure of the connection is
// a fixed one. The reply is awaited without a deadline — the work behind it (a migration, a boot)
// has no bound of its own — and ends early only when the connection does.

const net = require('node:net')
const { StringDecoder } = require('node:string_decoder')
const { assertPrivateSocketDir } = require('./window-connections.js')
const { FRAME, IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED } = require('../shared/contract/ipc-frames.js')
const { version } = require('../../package.json')

// A worker that announced its socket accepts at once; one that does not is not serving it.
const CONNECT_TIMEOUT_MS = 10000

const REQUEST_ID = 'main-1'

// The introduction main makes on every wire it uses: its version range and what it is.
function helloFrame() {
  return {
    type: FRAME.HELLO,
    protocolVersion: IPC_PROTOCOL_VERSION,
    protocolMin: IPC_PROTOCOL_MIN_SUPPORTED,
    protocolMax: IPC_PROTOCOL_VERSION,
    client: { kind: 'electron-main', name: 'mirall', version },
  }
}

function failure(message, code) {
  return Object.assign(new Error(message), code ? { code } : {})
}

// Resolves with the response's data; rejects with an Error carrying the worker's `code` when it
// refused, or none when the connection failed before an answer.
function requestOverSocket(socketPath, type, args = {}, {
  connect = (target) => net.connect(target),
  checkDir = assertPrivateSocketDir,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let socket = null
    let settled = false
    let connectTimer = null
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      socket?.destroy()
      settle(value)
    }

    try {
      checkDir(socketPath)
      socket = connect(socketPath)
    } catch (err) {
      finish(reject, err)
      return
    }
    connectTimer = setTimeout(() => finish(reject, failure('worker socket did not accept the connection')), connectTimeoutMs)

    socket.once('connect', () => {
      clearTimeout(connectTimer)
      socket.write(JSON.stringify(helloFrame()) + '\n' + JSON.stringify({ id: REQUEST_ID, type, ...args }) + '\n')
    })
    socket.on('error', () => finish(reject, failure('worker socket failed')))
    socket.on('close', () => finish(reject, failure('worker closed the connection before it answered')))

    const decoder = new StringDecoder('utf8')
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += decoder.write(chunk)
      const lines = buffered.split('\n')
      buffered = lines.pop()
      for (const line of lines) {
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame?.type === FRAME.KEEPALIVE) socket.write(JSON.stringify({ type: FRAME.KEEPALIVE_ACK }) + '\n')
        else if (frame?.type === FRAME.RESPONSE && frame.id === REQUEST_ID) {
          if (typeof frame.error === 'string' && frame.error) finish(reject, failure(frame.error, frame.code))
          else finish(resolve, frame.data)
        }
      }
    })
  })
}

module.exports = { requestOverSocket, helloFrame }
