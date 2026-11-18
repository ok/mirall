'use strict'

// One exchange between main and a worker, over the worker's own socket: main connects as a client of
// its own, says hello, takes the answer it came for and hangs up. A request's answer is its response;
// a greeting's is the worker's hello-ack. The spawn pipe stays the host's frames alone, and a window's
// connection stays a relay main never writes on.
//
// The request and its answer may carry a secret, so nothing here logs, echoes or puts either in an
// error: a refusal keeps the worker's own code and sentence, and every failure of the connection is
// a fixed one. A request's reply is awaited without a deadline — the work behind it (a migration, a
// boot) has no bound of its own — and ends early only when the connection does.

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

// The one failure that says something is there: the connection was accepted, and no answer came
// within the bound the caller set.
function unanswered() {
  return Object.assign(failure('worker did not answer in time'), { unanswered: true })
}

// `request` is the frame to send after the hello, or null to settle on the hello-ack. `answerTimeoutMs`
// bounds the wait for the answer once connected; without it the wait has no deadline.
function exchange(socketPath, request, {
  connect = (target) => net.connect(target),
  checkDir = assertPrivateSocketDir,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  answerTimeoutMs = 0,
} = {}) {
  return new Promise((resolve, reject) => {
    let socket = null
    let settled = false
    let timer = null
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
    timer = setTimeout(() => finish(reject, failure('worker socket did not accept the connection')), connectTimeoutMs)

    socket.once('connect', () => {
      clearTimeout(timer)
      if (answerTimeoutMs > 0) timer = setTimeout(() => finish(reject, unanswered()), answerTimeoutMs)
      socket.write(JSON.stringify(helloFrame()) + '\n' + (request ? JSON.stringify(request) + '\n' : ''))
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
        else if (!request && frame?.type === FRAME.HELLO_ACK) finish(resolve, frame)
        else if (request && frame?.type === FRAME.RESPONSE && frame.id === REQUEST_ID) {
          if (typeof frame.error === 'string' && frame.error) finish(reject, failure(frame.error, frame.code))
          else finish(resolve, frame.data)
        }
      }
    })
  })
}

// Resolves with the response's data; rejects with an Error carrying the worker's `code` when it
// refused, or none when the connection failed before an answer.
function requestOverSocket(socketPath, type, args = {}, options = {}) {
  return exchange(socketPath, { id: REQUEST_ID, type, ...args }, options)
}

// Resolves with the worker's hello-ack: what it is and which version it runs.
function greetOverSocket(socketPath, options = {}) {
  return exchange(socketPath, null, options)
}

module.exports = { requestOverSocket, greetOverSocket, helloFrame }
