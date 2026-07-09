// The renderer's worker channel: NDJSON request/response with timeouts over window.bridge, event:* fan-out, and crash-respawn recovery.
const WORKER_SPEC = '/src/worker/main.js'

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

interface IpcEnvelope {
  id?: number
  type?: string
  data?: unknown
  error?: string
  code?: string
  [key: string]: unknown
}

import { makeRespawnPolicy } from './workerRespawn.js'

// Mutable: recreated on worker exit so a worker that died mid-multibyte UTF-8 chunk
// can't leave dangling continuation state that corrupts the next worker's first frame.
let decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

const pending = new Map<number, PendingRequest>()
const listeners = new Map<string, Set<(msg: Record<string, unknown>) => void>>()

const DEFAULT_TIMEOUT = 30000
let nextId = 1
let buffer = ''
let workerStarted = false
let workerReady = false
let handlersBound = false
let shuttingDown = false
let permanentlyDown = false   // respawn policy gave up — requests fail fast instead of hanging
let respawnScheduled = false  // a respawn timer is armed — don't spawn a second worker
let recoveredFromCrash = false // the next 'ready' follows an unexpected exit → reload to re-sync the UI
const respawnPolicy = makeRespawnPolicy()
let readyResolve: (() => void) | null = null
let readyPromise = newReadyPromise()

function newReadyPromise(): Promise<void> {
  return new Promise<void>((resolve) => { readyResolve = resolve })
}

// Re-arm readiness for a fresh worker: install a NEW promise for future/looping waiters, then
// resolve the OLD one so anyone parked on it wakes and re-checks (they loop onto the new promise,
// or throw if we've given up). Without waking the old promise a parked request() would await an
// object that is never resolved again — a permanent hang across a respawn.
function armReady(): void {
  const wakePrev = readyResolve
  readyPromise = newReadyPromise()
  wakePrev?.()
}

function markReady(): void {
  if (workerReady) return
  workerReady = true
  readyResolve?.()
  respawnPolicy.recordReady()
  // A worker came back after an unexpected exit: in-flight requests were rejected and the fresh
  // worker has none of the renderer's prior subscriptions, so reload to re-establish them cleanly
  // (mirrors the OTA apply path). Never on first boot or during shutdown.
  if (recoveredFromCrash && !shuttingDown) {
    recoveredFromCrash = false
    window.location.reload()
  }
}

function handleLine(line: string): void {
  if (!line) return
  let msg: IpcEnvelope
  try {
    msg = JSON.parse(line) as IpcEnvelope
  } catch (err) {
    console.error('IPC parse error:', err)
    return
  }

  if (typeof msg.id === 'number' && pending.has(msg.id)) {
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (typeof msg.error === 'string' && msg.error.length > 0) {
      const err = new Error(msg.error) as Error & { code?: string }
      err.code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN'
      entry.reject(err)
    } else {
      entry.resolve(msg.data)
    }
    return
  }

  if (typeof msg.type !== 'string') return

  if (msg.type === 'event:worker-ready') {
    markReady()
    return
  }

  // Per-listener isolation: a throwing subscriber must not starve the listeners
  // registered after it, nor abort the chunk loop and drop the remaining NDJSON
  // lines (which include pending request responses).
  const cbs = listeners.get(msg.type)
  if (cbs) {
    cbs.forEach(cb => {
      try { cb(msg) } catch (err) { console.error('[ipc] subscriber failed for', msg.type, err) }
    })
  }
}

function failAllPending(reason: string): void {
  for (const [id, entry] of pending) {
    entry.reject(new Error(reason))
    pending.delete(id)
  }
}

// Bind the worker IPC/lifecycle handlers exactly ONCE for the app's lifetime. They
// listen on the per-specifier channels, which main re-broadcasts for whatever worker
// currently backs the specifier — so a single set of listeners keeps working across a
// respawn. (Re-binding on every spawn would stack duplicate ipcRenderer listeners.)
function bindHandlers(): void {
  if (handlersBound) return
  handlersBound = true

  const utf8 = new TextDecoder('utf-8')

  window.bridge.onWorkerIPC(WORKER_SPEC, (data) => {
    buffer += decoder.decode(data, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const line of parts) handleLine(line)
  })

  window.bridge.onWorkerStdout(WORKER_SPEC, (data) => {
    console.log('[worker stdout]', utf8.decode(data).trimEnd())
  })

  window.bridge.onWorkerStderr(WORKER_SPEC, (data) => {
    console.error('[worker stderr]', utf8.decode(data).trimEnd())
  })

  window.bridge.onWorkerExit(WORKER_SPEC, onWorkerExit)
}

// Recover from a worker death (crash / OOM on a very large folder) instead of leaving the app
// permanently dead behind 30s timeouts. Reset state, recreate the decoder, fail in-flight work,
// then let the policy decide whether to respawn — recovery is driven SOLELY from here so the
// backoff/give-up budget can't be bypassed by an incidental request().
function onWorkerExit(code: number): void {
  console.warn('worker exited with code', code, '(0x' + code.toString(16) + ')')
  workerReady = false
  workerStarted = false
  buffer = '' // drop any half-frame left by the dead worker
  decoder = new TextDecoder('utf-8')
  failAllPending('Worker exited with code ' + code)
  scheduleRespawn()
}

// Single gate governing every (re)spawn after the first boot. Honors the policy's backoff and
// give-up so a crash-loop can't spin forever, and wakes parked request()s on each transition.
function scheduleRespawn(): void {
  if (shuttingDown) { armReady(); return } // app quitting — leave the worker down, wake waiters
  if (respawnScheduled || permanentlyDown) { armReady(); return }
  const { respawn, delayMs } = respawnPolicy.onExit()
  if (!respawn) {
    permanentlyDown = true
    armReady() // wake parked requests so they throw fast instead of hanging
    console.error('worker exited repeatedly; not respawning — reload the app to recover')
    return
  }
  recoveredFromCrash = true
  respawnScheduled = true
  armReady() // parked requests re-arm onto the new promise and wait for the respawn
  setTimeout(() => {
    respawnScheduled = false
    if (!shuttingDown && !permanentlyDown) void spawnWorker()
  }, delayMs)
}

// ensureWorker only performs the FIRST boot; respawns are owned by scheduleRespawn. A request()
// arriving during backoff or after give-up must NOT spawn its own worker (that would defeat the
// policy) — it just waits on readyPromise (and throws fast if permanentlyDown).
async function ensureWorker(): Promise<void> {
  bindHandlers()
  if (workerStarted || respawnScheduled || permanentlyDown) return
  await spawnWorker()
}

async function spawnWorker(): Promise<void> {
  if (workerStarted) return
  workerStarted = true
  try {
    await window.bridge.startWorker(WORKER_SPEC)
  } catch (err) {
    // A spawn that never produced a worker emits no exit event, so feed it through the same
    // policy gate rather than latching workerStarted=true forever (which would wedge the app).
    console.error('worker spawn failed:', err)
    workerStarted = false
    scheduleRespawn()
    return
  }
  probeWorkerReady()
}

// `event:worker-ready` is emitted exactly once on worker startup. On a renderer
// reload the worker is reused (main.getWorker() keeps the existing handle), so
// the broadcast has already happened and our fresh listener never sees it. Ping
// the worker directly: a successful pong proves the worker is reachable, which
// is the same liveness guarantee `event:worker-ready` was conveying. On a clean
// boot, whichever signal arrives first flips workerReady; the other is a no-op.
function probeWorkerReady(): void {
  if (workerReady) return
  const id = nextId++
  // If readiness instead arrives via event:worker-ready (or the worker never pongs), this entry
  // would linger in `pending` forever; a timeout reaps it so repeated respawns don't accumulate.
  // (No unref: this is a renderer/DOM timer — setTimeout returns a number, and it's cleared on
  // every resolve/reject/error path below regardless.)
  const reap = setTimeout(() => { pending.delete(id) }, DEFAULT_TIMEOUT)
  pending.set(id, {
    resolve: () => { clearTimeout(reap); markReady() },
    reject: () => { clearTimeout(reap) },
  })
  const envelope = JSON.stringify({ id, type: 'ping' }) + '\n'
  window.bridge.writeWorkerIPC(WORKER_SPEC, encoder.encode(envelope)).catch(() => {
    clearTimeout(reap)
    pending.delete(id)
  })
}

if (typeof window !== 'undefined') {
  // Don't respawn a worker that exits because the app is quitting / the page is unloading (a real
  // crash is the only case we want to recover from). pagehide fires reliably on teardown/reload;
  // beforeunload covers the user-initiated close — latch on either, before the exit IPC can race in.
  const markShuttingDown = () => { shuttingDown = true }
  window.addEventListener('beforeunload', markShuttingDown)
  window.addEventListener('pagehide', markShuttingDown)
  ensureWorker().catch((err) => console.error('worker start failed:', err))
}

export async function request(
  type: string,
  payload: Record<string, unknown> = {},
  timeout = DEFAULT_TIMEOUT,
): Promise<unknown> {
  await ensureWorker()
  // Wait for the CURRENT worker to be ready, re-reading readyPromise each iteration so a respawn
  // (which re-arms it) wakes us onto the new worker instead of stranding us on a stale promise.
  // Fail fast if the respawn policy has given up rather than hanging until the IPC timeout.
  while (!workerReady) {
    if (permanentlyDown) throw new Error('Worker is unavailable (respawn limit reached)')
    await readyPromise
  }

  const id = nextId++
  return new Promise<unknown>((resolve, reject) => {
    const timer = timeout > 0
      ? setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`IPC timeout: ${type} (${timeout}ms)`))
          }
        }, timeout)
      : null

    pending.set(id, {
      resolve: (data) => { if (timer) clearTimeout(timer); resolve(data) },
      reject: (err) => { if (timer) clearTimeout(timer); reject(err) },
    })

    const envelope = JSON.stringify({ id, type, ...payload }) + '\n'
    window.bridge.writeWorkerIPC(WORKER_SPEC, encoder.encode(envelope)).catch((err) => {
      pending.delete(id)
      if (timer) clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

export function subscribe<T = Record<string, unknown>>(
  eventType: string,
  callback: (msg: T) => void,
): () => void {
  if (!listeners.has(eventType)) listeners.set(eventType, new Set())
  const stored = callback as (msg: Record<string, unknown>) => void
  listeners.get(eventType)!.add(stored)
  return () => { listeners.get(eventType)?.delete(stored) }
}

export async function addFileToSpace(spaceId: string, file: File): Promise<void> {
  const filePath = window.bridge.getPathForFile(file)
  if (!filePath) {
    // No backing path means the drop was pure in-memory data (e.g. an unsaved
    // screenshot / Photo Booth capture). Carry the worker's code so the renderer
    // shows the same "not saved to disk" message it shows for ephemeral sources.
    const err = new Error('File is not saved on disk') as Error & { code?: string }
    err.code = 'SOURCE_NOT_ON_DISK'
    throw err
  }
  await request('files:add', {
    spaceId,
    filePath,
    fileName: file.name,
    fileSize: file.size,
  }, 0)
}
