// The two launch marks, observed from outside an installed build: nothing here relies on a test
// hook, an environment lever or a log line, which a packaged build either ignores or does not print.
//
// backendReady — the back end's own socket. A client that connects and says hello is greeted with
// `event:state` (or `event:profile-needed` on a profile without one) only once the data layer is
// open and every handler is registered. Before that a back end greets with nothing, or, while it
// waits for its key, with `event:worker-ready` alone. The time is taken when the frame arrives.
//
// spacesShown — the window's DOM, through the DevTools protocol the app is started with. A script
// in the page stamps the renderer's clock when the spaces list first holds an item, so the poll
// that collects the stamp adds nothing to it.
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { FRAME, IPC_PROTOCOL_VERSION } from '../../src/shared/contract/ipc-frames.js'
import { socketPaths } from '../../src/shared/core/socket-path.js'

const require = createRequire(import.meta.url)

export const now = () => performance.timeOrigin + performance.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CONNECT_RETRY_MS = 5
const STAMP_POLL_MS = 50
const READY_EVENTS = new Set(['event:state', 'event:profile-needed'])
export const SPACES_SELECTOR = '[role="list"] [role="listitem"]'

/**
 * Where the back end of the app started with `--storage <dataDir>` listens: the app keeps its store
 * in <dataDir>/app-storage, and the listener names its socket from that path.
 * @param {string} dataDir absolute, exactly as passed to --storage
 */
export function backendSocketPath(dataDir) {
  const storage = path.join(dataDir, 'app-storage')
  const { hash } = require('hypercore-crypto')
  return socketPaths({
    platform: process.platform,
    dataDir: path.dirname(storage),
    storageHash: hash(Buffer.from(storage)).toString('hex'),
    uid: process.platform === 'win32' ? -1 : os.userInfo().uid,
    tmpdir: os.tmpdir(),
  }).socket
}

/** @param {string} socketPath @returns {Promise<boolean>} whether anything accepts a connection there */
export function socketAnswers(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

// A wide range, so one hello is accepted by back ends on either side of a protocol bump; one that
// still refuses names the version it speaks, and the next hello uses that.
function helloFrame(version) {
  return {
    type: FRAME.HELLO,
    protocolVersion: version,
    protocolMin: 1,
    protocolMax: version,
    client: { kind: 'cli', name: 'launch-timing', version: '1' },
  }
}

/**
 * One connection: resolves with what it saw, or with `retry` when it should be made again.
 * @param {string} socketPath @param {number} version
 */
function attempt(socketPath, version) {
  return new Promise((resolve) => {
    const seen = { connectedAt: null, workerReadyAt: null, readyAt: null, readyEvent: null, appVersion: null }
    const socket = net.connect(socketPath)
    let buffered = ''
    const done = (result) => { socket.destroy(); resolve(result) }
    socket.once('connect', () => {
      seen.connectedAt = now()
      socket.write(JSON.stringify(helloFrame(version)) + '\n')
    })
    socket.on('error', () => done({ retry: version, seen }))
    socket.on('close', () => done({ retry: version, seen }))
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      const at = now()
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop()
      for (const line of lines) {
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame.type === FRAME.KEEPALIVE) socket.write(JSON.stringify({ type: FRAME.KEEPALIVE_ACK }) + '\n')
        else if (frame.type === FRAME.HELLO_ACK && !frame.ok) done({ retry: Number.isInteger(frame.ours) ? frame.ours : version, seen })
        else if (frame.type === FRAME.HELLO_ACK) seen.appVersion = frame.appVersion ?? null
        else if (frame.type === 'event:worker-ready') seen.workerReadyAt ??= at
        else if (READY_EVENTS.has(frame.type)) {
          seen.readyAt = at
          seen.readyEvent = frame.type
          done({ retry: null, seen })
          return
        }
      }
    })
  })
}

/**
 * Connects as soon as the socket exists and waits for the greeting a live data layer sends.
 * @param {string} socketPath @param {{ deadline: number }} opts
 */
export async function watchBackend(socketPath, { deadline }) {
  let version = IPC_PROTOCOL_VERSION
  let firstConnect = null
  let workerReady = null
  while (now() < deadline) {
    const { retry, seen } = await attempt(socketPath, version)
    firstConnect ??= seen.connectedAt
    workerReady ??= seen.workerReadyAt
    if (retry === null) {
      return { socketAt: firstConnect, workerReadyAt: workerReady, readyAt: seen.readyAt, readyEvent: seen.readyEvent, appVersion: seen.appVersion }
    }
    version = retry
    await sleep(CONNECT_RETRY_MS)
  }
  throw new Error('the back end did not report ready before the deadline')
}

// Runs in the page before its own scripts. `document` is observed rather than its root element,
// which does not exist yet at that point.
const STAMP_SCRIPT = `(() => {
  if (window.__launchTimingWatch) return
  window.__launchTimingWatch = true
  const check = () => {
    if (window.__launchTimingMark != null || !document.querySelector(${JSON.stringify(SPACES_SELECTOR)})) return
    window.__launchTimingMark = performance.timeOrigin + performance.now()
    observer.disconnect()
  }
  const observer = new MutationObserver(check)
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] })
  check()
  window.__launchTimingAtInstall = window.__launchTimingMark != null
})()`

const STAMP_READ = '({ at: window.__launchTimingMark ?? null, late: window.__launchTimingAtInstall === true })'

function cdpSession(url) {
  const ws = new WebSocket(url)
  let nextId = 1
  const pending = new Map()
  const listeners = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method) {
      for (const fn of listeners) fn(msg)
    }
  })
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('DevTools connection failed')), { once: true })
  })
  return {
    opened,
    send(method, params = {}, sessionId) {
      const id = nextId++
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    on(fn) { listeners.push(fn) },
    close() { try { ws.close() } catch {} },
  }
}

/**
 * Attaches to the app's window and waits for its stamp. The script goes into the current document
 * and every later one. A starting page is never held for it: a page paused before its first load
 * fails main's loadURL, and no window means no back end either, since the window starts it. The
 * window usually exists before the DevTools connection opens, which is early enough unless the list
 * was already there; `late` says it was, and the stamp is then only an upper bound.
 * @param {string} browserUrl the ws:// endpoint the app printed
 * @param {{ deadline: number }} opts
 */
export async function watchSpacesShown(browserUrl, { deadline }) {
  const cdp = cdpSession(browserUrl)
  await cdp.opened
  const pages = []
  cdp.on(async (msg) => {
    if (msg.method !== 'Target.attachedToTarget') return
    const { sessionId, targetInfo } = msg.params
    if (targetInfo.type !== 'page' || targetInfo.url.startsWith('devtools://')) return
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STAMP_SCRIPT }, sessionId).catch(() => {})
    await cdp.send('Runtime.evaluate', { expression: STAMP_SCRIPT }, sessionId).catch(() => {})
    pages.push(sessionId)
  })
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  try {
    while (now() < deadline) {
      for (const sessionId of pages) {
        const result = await cdp.send('Runtime.evaluate', { expression: STAMP_READ, returnByValue: true }, sessionId)
          .catch(() => null)
        const stamp = result?.result?.value
        if (Number.isFinite(stamp?.at)) return { shownAt: stamp.at, late: stamp.late }
      }
      await sleep(STAMP_POLL_MS)
    }
    throw new Error(`the spaces list (${SPACES_SELECTOR}) did not appear before the deadline`)
  } finally {
    cdp.close()
  }
}

const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)/

/** @param {string} line @returns {string | null} */
export function devtoolsUrlIn(line) {
  return DEVTOOLS_LINE.exec(line)?.[1] ?? null
}
