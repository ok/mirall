import type { RequestName } from '../../shared/contract/requests.js'
import type { RequestResponse } from '../../shared/contract/responses.js'
import type { EventName } from '../../shared/contract/events.js'
import { FRAME } from '../../shared/contract/ipc-frames.js'
import { MAIN_WORKER_SPEC } from '../../shared/contract/workers.js'
import { CODES } from '../../shared/contract/errors.js'
import { createEventCursor } from '../../shared/contract/event-cursor.js'
import { resyncQueries } from '../store/query-store.js'
// The renderer's worker channel: NDJSON request/response with timeouts over window.bridge, event:* fan-out, and crash-respawn recovery.
//
// One JSON object per line, in both directions. A request is { id, type, ...payload } and its answer
// is { id, data } or { id, error, code }; { id, type: 'ping' } is the readiness probe and is answered
// the same way. { type: 'cancel', id } is a control frame rather than a request, so it cannot queue
// behind the request it cancels. Any other line carrying a string `type` is an event, fanned out to
// subscribe()'s listeners — except event:worker-ready, which the channel consumes itself and which
// arrives once per worker CONNECTION: main holds one across renderers, so a window that comes up
// over a running worker never sees it.
//
// subscribe() takes a declared EventName and allows any number of listeners per name. They are called
// synchronously, each inside its own try: a throwing subscriber must not starve the listeners after
// it, nor abort the chunk loop — which would drop the request responses sharing that read.
const WORKER_SPEC = MAIN_WORKER_SPEC

const ECANCELLED = CODES.ECANCELLED

export interface RequestOptions {
  signal?: AbortSignal
}

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

interface IpcEnvelope {
  id?: number
  type?: string
  // The frame's ordinal on the worker's event stream. Absent on a response, which is what makes a
  // response a no-op for the cursor.
  seq?: number
  data?: unknown
  error?: string
  code?: string
  [key: string]: unknown
}

import { exitDisposition, makeRespawnPolicy } from './worker-respawn.js'

// Recreated on worker exit: a worker that died mid-multibyte UTF-8 chunk must not leave
// continuation state that corrupts the next worker's first frame (main needs no reset — its reader
// lives in the per-worker getWorker() closure). One decoder per stream: stdout and stderr
// interleave, and a log line split mid-character would render U+FFFD on both halves.
let decoder = new TextDecoder('utf-8')
let stdoutDecoder = new TextDecoder('utf-8')
let stderrDecoder = new TextDecoder('utf-8')
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
let restartInFlight = false   // main is replacing the worker on purpose — its exit is not a crash
// Bumped by every worker exit, so work that spans one can tell whether the process it started
// against is still the process it would be finishing against.
let workerGeneration = 0
const respawnPolicy = makeRespawnPolicy()

// Where this client has read to on the worker's event stream, and the per-connection worker state
// a new generation has to be asked for again.
const cursor = createEventCursor()
const resyncHooks = new Set<(reason: ResyncReason) => void>()

// The channel is terminally down and no request will ever be answered again. Exposed as a store
// rather than only as a rejection code because the app shell has to gate on it BEFORE the profile
// gate: a failed profile:get reads as "no profile" and opens onboarding over an identity that
// exists (profile-gate.js).
export type ChannelFault = 'protocol' | 'budget'
let channelFault: ChannelFault | null = null
const faultListeners = new Set<() => void>()

export function getChannelFault(): ChannelFault | null { return channelFault }

export function subscribeChannelFault(fn: () => void): () => void {
  faultListeners.add(fn)
  return () => { faultListeners.delete(fn) }
}

function raiseChannelFault(kind: ChannelFault): void {
  if (channelFault) return
  channelFault = kind
  faultListeners.forEach((fn) => { try { fn() } catch (err) { console.error('[ipc] fault listener failed', err) } })
}
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
}

// Why a client's whole view has to be re-read. 'new-worker' is a process that has never heard of
// anything this client set up; 'gap' is the same process, still holding it, whose ring can no longer
// say what was missed. State keyed by the worker's IDENTITY — what it booted from — survives the
// second and not the first, so the two are not interchangeable.
export type ResyncReason = 'new-worker' | 'gap'

// A hook whose request created state on the WORKER keyed by this connection — a serve-detail
// subscription, the verbose refcount — re-issues it here after a re-read. The renderer's own event
// listeners need nothing: they live in this module and outlive any worker.
export function onResync(fn: (reason: ResyncReason) => void): () => void {
  resyncHooks.add(fn)
  return () => { resyncHooks.delete(fn) }
}

// The re-arms are ISSUED first: each is one small frame restarting a push the worker would otherwise
// never resume, and building them after every refetched listing would leave a live view silent for
// as long as the reads take. Issue order only — both go through request(), so the order they reach
// the wire is whatever its worker wait hands back, and nothing here depends on that.
function resync(reason: ResyncReason): void {
  resyncHooks.forEach((fn) => {
    try { fn(reason) } catch (err) { console.error('[ipc] resync hook failed', err) }
  })
  resyncQueries()
}

// What a greeting from a worker means for a client that has been listening. The same stream is
// replayable; a different one is a new process whose ring holds frames this client never asked
// about, so only a full re-read is honest. markReady comes last in every branch: a request parked
// on readiness must not race the catch-up it is about to depend on.
async function settleArrival(coords: { epoch: string, head: number }, generation: number): Promise<void> {
  const verdict = cursor.arrived(coords)
  if (verdict === 'resync') {
    resync('new-worker')
  } else if (verdict === 'resume') {
    const answer = await dispatch('events:resume', cursor.cursor(), DEFAULT_TIMEOUT, {})
    if (cursor.resumed(answer) === 'resync') resync('gap')
  }
  if (generation !== workerGeneration) return
  markReady()
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

  // Before the worker-ready test: the greeting carries an ordinal of its own, and the cursor has to
  // see every numbered frame in the order the pipe delivered them.
  cursor.observe(msg)

  if (msg.type === 'event:worker-ready') {
    const greeted = workerGeneration
    settleArrival({
      epoch: typeof msg.epoch === 'string' ? msg.epoch : '',
      head: typeof msg.head === 'number' ? msg.head : 0,
    }, greeted).catch((err) => {
      // The worker could not say what we missed, so we have to assume we missed something. Ready is
      // set either way: a channel that never reports ready parks every request behind the catch-up.
      // Unless the worker that greeted us has since exited — the successor's own greeting settles
      // that generation, and marking ready for a process that is gone wakes every parked request
      // into a pipe with nothing behind it.
      if (greeted !== workerGeneration) return
      console.warn('[ipc] catch-up failed, resyncing', err)
      // A greeting is emitted per connection and main connects once per worker, so a greeting we
      // could not settle is still a process this client has told nothing.
      resync('new-worker')
      markReady()
    })
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

function failAllPending(reason: string, code: string): void {
  for (const [id, entry] of pending) {
    entry.reject(codedError(reason, code))
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

  window.bridge.onWorkerIPC(WORKER_SPEC, (data) => {
    buffer += decoder.decode(data, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const line of parts) handleLine(line)
  })

  window.bridge.onWorkerStdout(WORKER_SPEC, (data) => {
    // Empty whenever a chunk ends mid-character — the decoder holds those bytes for the next one.
    const text = stdoutDecoder.decode(data, { stream: true })
    if (text) console.log('[worker stdout]', text.trimEnd())
  })

  window.bridge.onWorkerStderr(WORKER_SPEC, (data) => {
    const text = stderrDecoder.decode(data, { stream: true })
    if (text) console.error('[worker stderr]', text.trimEnd())
  })

  window.bridge.onWorkerExit(WORKER_SPEC, onWorkerExit)
}

// Recover from a worker death (crash / OOM on a very large folder) instead of leaving the app
// permanently dead behind 30s timeouts. Reset state, recreate the decoder, fail in-flight work,
// then let the policy decide whether to respawn — recovery is driven SOLELY from here so the
// backoff/give-up budget can't be bypassed by an incidental request().
function onWorkerExit(code: number): void {
  console.warn('worker exited with code', code, '(0x' + code.toString(16) + ')')
  workerGeneration += 1
  workerReady = false
  workerStarted = false
  buffer = '' // drop any half-frame left by the dead worker
  decoder = new TextDecoder('utf-8')
  stdoutDecoder = new TextDecoder('utf-8')
  stderrDecoder = new TextDecoder('utf-8')
  failAllPending('Worker exited with code ' + code, CODES.WORKER_UNAVAILABLE)
  // A restart we asked for is not a crash. Main already has the next worker coming, so the policy
  // is not consulted and no budget is spent; the new generation's greeting is what re-establishes
  // the per-connection state.
  if (exitDisposition({ shuttingDown, restartInFlight }) === 'restart') {
    armReady()
    return
  }
  scheduleRespawn(code)
}

// A deliberate worker restart. The relay identity, and every other value read only at spawn, take
// effect in the next generation and nowhere else — so applying one genuinely needs a new process.
// Routing that through the crash path spent a respawn budget and made an intentional act
// indistinguishable from a failure to every layer below the button.
export async function restartWorker(): Promise<void> {
  if (restartInFlight) return
  restartInFlight = true
  try {
    const replaced = await window.bridge.restartWorker(WORKER_SPEC)
    if (!replaced) return // the app is quitting; there is no next worker to wait for
    workerStarted = true
    probeWorkerReady()
  } catch (err) {
    // Main could not finish it. Whatever state the worker is in, the crash path knows how to
    // recover from "no worker" — leaving the app wedged behind a failed restart is the worse end.
    // The failure still reaches the caller: the restart the user asked for did not happen.
    if (!workerStarted) scheduleRespawn(0)
    throw err
  } finally {
    restartInFlight = false
  }
}

// Single gate governing every (re)spawn after the first boot. Honors the policy's backoff and
// give-up so a crash-loop can't spin forever, and wakes parked request()s on each transition.
function scheduleRespawn(exitCode: number): void {
  if (shuttingDown) { armReady(); return } // app quitting — leave the worker down, wake waiters
  if (respawnScheduled || permanentlyDown) { armReady(); return }
  const { respawn, delayMs, terminal } = respawnPolicy.onExit(exitCode)
  if (!respawn) {
    permanentlyDown = true
    armReady() // wake parked requests so they throw fast instead of hanging
    raiseChannelFault(terminal === 'protocol' ? 'protocol' : 'budget')
    console.error(terminal === 'protocol'
      ? 'worker refused the connection: protocol version mismatch'
      : 'worker exited repeatedly; not respawning — reload the app to recover')
    return
  }
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
    scheduleRespawn(0) // no worker ever ran, so this is not an unstable exit
    return
  }
  probeWorkerReady()
}

// `event:worker-ready` is emitted once per worker CONNECTION, and main holds that connection across
// renderers: a window that comes up over a worker already running — a reload, or re-opening from
// the tray or the dock — never sees the greeting. Ping the worker directly: a successful pong
// proves it is reachable, which is the same liveness guarantee the greeting was conveying. On a
// clean boot, whichever signal arrives first flips workerReady; the other is a no-op.
//
// The pong also tells the cursor it is LIVE on a stream it has no coordinates for, which is what
// separates this window from one that has never been connected: the next greeting it sees is a
// different process, and everything it is holding came from the one before it.
function probeWorkerReady(): void {
  if (workerReady) return
  const id = nextId++
  // If readiness instead arrives via event:worker-ready (or the worker never pongs), this entry
  // would linger in `pending` forever; a timeout reaps it so repeated respawns don't accumulate.
  // (No unref: this is a renderer/DOM timer — setTimeout returns a number, and it's cleared on
  // every resolve/reject/error path below regardless.)
  const reap = setTimeout(() => { pending.delete(id) }, DEFAULT_TIMEOUT)
  pending.set(id, {
    resolve: () => { clearTimeout(reap); cursor.connected(); markReady() },
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

// Every rejection this module raises itself carries a code: errorTextFor keys on `.code`, and one
// without it renders the generic sentence — the outcome that makes a stalled or dead worker
// indistinguishable from any other failure in the UI.
function codedError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

function cancelledError(type: RequestName): Error & { code: string } {
  return codedError(`cancelled: ${type}`, ECANCELLED)
}

export async function request<K extends RequestName>(
  type: K,
  payload: Record<string, unknown> = {},
  timeout = DEFAULT_TIMEOUT,
  opts: RequestOptions = {},
): Promise<RequestResponse[K]> {
  // Refused before the worker wait, not after: an already-aborted caller must not be parked on a
  // respawn it has no interest in the outcome of.
  if (opts.signal?.aborted) throw cancelledError(type)
  await ensureWorker()
  // Wait for the CURRENT worker to be ready, re-reading readyPromise each iteration so a respawn
  // (which re-arms it) wakes us onto the new worker instead of stranding us on a stale promise.
  // Fail fast if the respawn policy has given up rather than hanging until the IPC timeout.
  while (!workerReady) {
    if (permanentlyDown) throw codedError('Worker is unavailable (respawn limit reached)', CODES.WORKER_UNAVAILABLE)
    await readyPromise
  }
  return dispatch(type, payload, timeout, opts)
}

// The frame, its timeout and its cancellation — everything request() does once the worker is known
// to be there. Private, and the one caller that skips the readiness wait is the catch-up the
// readiness signal itself triggers: it cannot wait for a flag it is on the way to setting.
function dispatch<K extends RequestName>(
  type: K,
  payload: Record<string, unknown>,
  timeout: number,
  opts: RequestOptions,
): Promise<RequestResponse[K]> {
  const id = nextId++
  return new Promise<RequestResponse[K]>((resolve, reject) => {
    const signal = opts.signal
    // A caller may reuse one signal across many reads (one per screen), so a listener left behind
    // on every settled request would accumulate for the life of that signal.
    const detach = (): void => { signal?.removeEventListener('abort', onAbort) }

    // Fire-and-forget, and the local rejection never waits for it: the worker's answer is
    // irrelevant once we have stopped listening, and awaiting an ack would put a round-trip in
    // front of an operation whose whole purpose is to stop waiting. A late response finds no
    // pending entry and is dropped by handleLine.
    const tellWorkerToStop = (): void => {
      const frame = JSON.stringify({ type: FRAME.CANCEL, id }) + '\n'
      void window.bridge.writeWorkerIPC(WORKER_SPEC, encoder.encode(frame)).catch(() => undefined)
    }

    const timer = timeout > 0
      ? setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          detach()
          // Giving up locally is not enough: the worker keeps the request in flight, holding
          // whatever it captured, until its own deadline — if the row even has one. An abandoned
          // request is a cancelled request, and it says so on the wire.
          tellWorkerToStop()
          reject(codedError(`IPC timeout: ${type} (${timeout}ms)`, CODES.TIMEOUT))
        }
      }, timeout)
      : null

    function onAbort(): void {
      if (!pending.has(id)) return
      pending.delete(id)
      if (timer) clearTimeout(timer)
      detach()
      tellWorkerToStop()
      reject(cancelledError(type))
    }

    // Re-checked here, not only on entry: the caller may have aborted during the worker-ready wait
    // above, and a listener attached to an already-aborted signal never fires — the request would
    // run to completion with nobody left to receive it.
    if (signal?.aborted) {
      if (timer) clearTimeout(timer)
      reject(cancelledError(type))
      return
    }

    pending.set(id, {
      // The one assertion in the channel. The wire is untyped JSON, and this is where the
      // contract's claim about it is applied — once, rather than at each of the call sites that
      // used to carry the same cast with nothing tying it to the request name.
      resolve: (data) => { if (timer) clearTimeout(timer); detach(); resolve(data as RequestResponse[K]) },
      reject: (err) => { if (timer) clearTimeout(timer); detach(); reject(err) },
    })

    signal?.addEventListener('abort', onAbort, { once: true })

    const envelope = JSON.stringify({ id, type, ...payload }) + '\n'
    window.bridge.writeWorkerIPC(WORKER_SPEC, encoder.encode(envelope)).catch((err) => {
      pending.delete(id)
      if (timer) clearTimeout(timer)
      detach()
      // The write reaches main, not the worker, so its failure means no worker is behind the
      // channel — the same thing a request has to tell the user as an exit does. The bridge's own
      // message goes to the console; the sentence a person reads comes from the code.
      console.error('worker write failed:', type, err)
      reject(codedError(`worker write failed: ${type}`, CODES.WORKER_UNAVAILABLE))
    })
  })
}

export function subscribe<T = Record<string, unknown>>(
  eventType: EventName,
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
