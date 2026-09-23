// The worker end of the renderer↔worker pipe: NDJSON request/response framing with a
// handler table, `event:*` pushes, and the coalesced reconcile hint bus. Frames arriving
// before start() are queued so no request is lost during boot.
import { createLogger, fields } from './logger.js'
import { EXPECTED_CODES as CONTRACT_EXPECTED_CODES, INVALID_ARGUMENT } from '../contract/errors.js'
import { IPC_MAX_FRAME_BYTES } from '../contract/limits.js'
import { FRAME, TRUST } from '../contract/ipc-frames.js'
import { createEventPlane, scopeForEvent } from './ipc-events.js'
import { createClientRegistry } from './ipc-client.js'
import { createDispatcher } from './ipc-dispatch.js'
import { createDeadlineWatch } from './ipc-deadlines.js'
import { createHandshake } from './ipc-handshake.js'
import { AppError } from './errors.js'
import { CODES } from '../contract/errors.js'
import { createHandlerTable } from './handler-table.js'
import { createRequestMetrics } from './request-metrics.js'
import { createFrameReader } from './frame-reader.js'
/** @import { RequestName } from '../contract/requests.js' */
/** @import { RequestHandler } from './handler-table.js' */
/** @import { Client } from './ipc-client.js' */

const log = createLogger('ipc')

// Re-exported from its new home so the guards that read the poke table keep one import path.
export { scopeForEvent }

// Ordinary control flow rather than faults: the user cancelled, or a bounded read gave up as
// designed. Logging these at warn would teach the reader to ignore the level. Both are genuinely
// thrown — ECANCELLED by the overlay backend on an aborted read, PREVIEW_CANCELLED by walk-disk.js.
const EXPECTED = new Set(CONTRACT_EXPECTED_CODES)

// The code half is a closed set, but the type half is whatever the renderer sent — an unknown
// command is counted under its requested name, so a buggy or looping caller could otherwise grow
// this map without bound. Unknown types collapse into one bucket, and the map is capped.
const MAX_FAILURE_KEYS = 256
const requestFailures = new Map()

// Frames arriving before start() are queued so no request is lost during boot — which runs the
// migrations and the drive load and can take seconds on a large library. Uncapped, a caller
// retrying across that window grows this without bound. Worker-internal capacity with no
// counterpart on the sender's side, so unlike IPC_MAX_FRAME_BYTES it is NOT contract vocabulary.
const MAX_QUEUED_FRAMES = 1000

// Per-request timing and outcomes: the router has the numbers, so a cost claim is checkable rather
// than estimated.
const requestMetrics = createRequestMetrics()

export function getRequestMetrics() {
  return requestMetrics.snapshot()
}

/** @internal */
export function resetRequestMetrics() {
  requestMetrics.reset()
}

// Ordered key=value rather than JSON, message included: the transport is a console line forwarded
// to main and read by a human with grep. The error's own fields are spread FIRST so the router's
// canonical keys win a name clash.
function logRequestFailure(log, { req, id, code, ms, message, extra }) {
  const bag = fields({ ...(extra || {}), req, id, code, ms, msg: message })
  if (EXPECTED.has(code)) log.debug('req-failed', bag)
  else log.warn('req-failed', bag)
}

export function getRequestFailureCounters() {
  const out = {}
  for (const [key, n] of requestFailures) out[key] = n
  return out
}

/** @internal */
export function resetRequestFailureCounters() {
  requestFailures.clear()
}

// `requests` is injectable so a test can declare the small vocabulary it exercises. Production
// passes nothing and gets the real contract, which is what makes an unknown handler name a boot
// failure rather than a 404 discovered in the field.
/** @typedef {ReturnType<typeof createIPC>} WorkerIpc */
export function createIPC(pipe, {
  requests, maxFrameBytes = IPC_MAX_FRAME_BYTES, maxQueuedFrames = MAX_QUEUED_FRAMES, now = Date.now,
  epoch = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
  replay,
} = {}) {
  // The table owns the request metadata; `handle` is a thin shim onto it so registrations keep
  // working while domains move onto register(ipc, deps).
  const table = createHandlerTable(requests ? { requests } : {})
  // Per-instance, like the queue and unlike the metrics counters: a client set is control state,
  // so a second router in the same process (every test that builds one) must not be able to abort
  // the first one's work.
  const clients = createClientRegistry({
    headAt: () => events.head(),
    bindReader: (client) => bindReader(client),
    onRemoved: (client, reason) => {
      // Dropped without answering: there is nobody left to receive the refusal.
      for (let i = queued.length - 1; i >= 0; i--) if (queued[i].client === client) queued.splice(i, 1)
      return abortClient(client, reason || 'client disconnected')
    },
    log,
  })
  // Pre-start frames, each with the client that sent it. The owner is not decoration: ids are
  // caller-minted and every caller starts at 1, so a cancel arriving during boot would otherwise
  // drop a different client's identically-numbered frame.
  const queued = []
  let ready = false

  // One reader per client: it holds partial-frame state, so a shared one would splice two clients'
  // bytes into a frame neither sent.
  function bindReader(client) {
    const reader = createFrameReader({
      maxFrameBytes,
      onOversized: (bytes) => {
        log.warn('oversized frame discarded:', bytes, 'bytes exceeds', maxFrameBytes)
        countFailure('oversized-frame', INVALID_ARGUMENT)
      },
    })
    client.onData((chunk) => {
      for (const line of reader.push(chunk)) {
        try { readFrame(client, JSON.parse(line)) } catch (err) {
          // A malformed frame is recoverable — skip the line and keep reading
          // (NDJSON resync). Debug-level so a stray/partial frame doesn't spam the
          // console; enable verbose to diagnose genuine IPC corruption.
          log.debug('skipped unparseable frame:', err.message)
        }
      }
    })
  }

  function readFrame(client, msg) {
    // First, and before the `ready` test: a client must be able to introduce itself during a slow
    // boot, and nothing else it sends is honoured until it has.
    if (msg && msg.type === FRAME.HELLO) {
      handshake.greetClient(client, msg)
      return
    }
    if (msg && msg.type === FRAME.BOOTSTRAP) {
      // Only from the first client. The frame carries the identity KEK and the storage path, so a
      // peer that attached later must not be able to settle — or re-settle — the worker's boot.
      if (client === primary) handshake.readBootstrap(client, msg)
      else log.warn('bootstrap frame from a non-primary client, ignored')
      return
    }
    // Refused rather than queued: a client that skipped the handshake is not one whose work should
    // start the moment boot finishes.
    if (!client.hello) {
      log.warn('frame before hello, refused:', msg && msg.type)
      countFailure((msg && msg.type) || 'unknown-command', CODES.NOT_AUTHORIZED)
      respond(msg && msg.id, null, 'hello first', CODES.NOT_AUTHORIZED, null, client)
      return
    }
    // Before the `ready` test on purpose: a cancel dispatched through the queue would be
    // processed AFTER the request it cancels, so a slow boot — the one moment cancelling is
    // most useful — is the one moment it would not work.
    if (msg && msg.type === FRAME.CANCEL) {
      cancel(msg.id, client)
      return
    }
    if (ready) {
      dispatch(client, msg)
    } else if (queued.length >= maxQueuedFrames) {
      // Refused, not silently dropped: a caller awaiting a response must not hang on a promise
      // nothing will ever settle. Keeping the OLDEST keeps the frames most likely to be the
      // session's real first requests.
      log.warn('pre-start queue full, frame refused:', msg.type)
      countFailure(msg.type || 'unknown-command', INVALID_ARGUMENT)
      respond(msg.id, null, 'worker is still starting', INVALID_ARGUMENT, null, client)
    } else {
      queued.push({ client, msg })
    }
  }

  const dispatch = createDispatcher({ table, metrics: requestMetrics, countFailure, respond, log, logRequestFailure, now })

  // Best-effort and idempotent: a cancel for an id that has already settled, was never sent, or was
  // already cancelled is a no-op, because the renderer fires it without waiting to learn which.
  function cancel(id, client = primary) {
    if (id == null || !client) return
    // The queue first. A frame that has not been dispatched has no token to abort, and leaving it
    // queued means the cancel is ignored and the work runs in full the moment start() fires.
    const queuedAt = queued.findIndex((q) => q.client === client && q.msg && q.msg.id === id)
    if (queuedAt !== -1) {
      const [dropped] = queued.splice(queuedAt, 1)
      log.debug('cancel', id, `(${dropped.msg.type}, dropped from the pre-start queue)`)
      // Answered, unlike an in-flight cancel: nothing else ever will, and a caller that has not yet
      // discarded its pending entry would otherwise wait out the renderer's full request timeout.
      respond(id, null, 'cancelled before dispatch', CODES.ECANCELLED, null, client)
      return
    }
    const flight = client.inFlight.get(id)
    if (!flight) { log.debug('cancel', id, '(already settled or unknown)'); return }
    log.debug('cancel', id, '(in flight)')
    flight.cancellation.abort(new AppError(CODES.ECANCELLED, 'cancelled by the caller'))
  }

  // Every outstanding request, aborted before the data layer closes under it. Without this a handler
  // parked on a bee read that is about to be closed throws a "session closed" error into the crash
  // backstop's fault window; aborting first routes it through the ECANCELLED path the router already
  // treats as expected.
  function abortClient(client, reason) {
    const n = client.inFlight.size
    if (!n) return 0
    for (const flight of [...client.inFlight.values()]) {
      flight.cancellation.abort(new AppError(CODES.ECANCELLED, reason))
    }
    return n
  }

  function abortAll(reason) {
    let n = 0
    for (const client of clients.all()) n += abortClient(client, reason || 'worker is shutting down')
    if (n) log.debug('aborting', n, 'in-flight requests')
    return n
  }

  function countFailure(type, code) {
    const key = `${type}:${code}`
    if (!requestFailures.has(key) && requestFailures.size >= MAX_FAILURE_KEYS) {
      requestFailures.set('other:OVERFLOW', (requestFailures.get('other:OVERFLOW') || 0) + 1)
      return
    }
    requestFailures.set(key, (requestFailures.get(key) || 0) + 1)
  }

  // The answering client defaults to the first: every caller outside this module has exactly one,
  // and a test that calls respond() directly is describing that one.
  function respond(id, data, error, code, errorFields, client = primary) {
    if (!id || !client) return
    const msg = error
      ? { id, type: 'response', error, code, ...(errorFields ? { fields: errorFields } : {}) }
      : { id, type: 'response', data }
    client.write(JSON.stringify(msg) + '\n')
  }

  const events = createEventPlane({ clients, log, epoch, replay })
  const { emit, resume } = events
  const handshake = createHandshake({ log, events, clients, isPrimary: (client) => client === primary })

  /** @template {RequestName} N @param {N} type @param {RequestHandler<N>} fn */
  function handle(type, fn) {
    table.register(type, fn)
  }

  const { sweepDeadlines, inFlightAges } = createDeadlineWatch({ clients, log, now })

  function start() {
    ready = true
    for (const { client, msg } of queued) dispatch(client, msg)
    queued.length = 0
    clients.goLive()
  }

  // The pipe handed to createIPC is the first client's, and the spawn pipe is the host by
  // construction: it is the process that started us, and the only one that may stop us.
  const primary = pipe ? clients.attach(pipe, { trust: TRUST.HOST }) : null

  return {
    handle, emit, respond, start, cancel, abortAll, sweepDeadlines, inFlightAges, resume,
    epoch: events.epoch,
    head: events.head,
    attach: (p, opts) => clients.attach(p, opts),
    detach: (client, reason) => clients.detach(client, reason),
    onClientAttach: /** @param {(client: Client) => void | Promise<void>} fn */ (fn) => clients.onAttach(fn),
    onClientDisconnect: /** @param {(client: Client) => void} fn */ (fn) => clients.onDisconnect(fn),
    primary,
    bootstrapPromise: handshake.bootstrapPromise,
    // The pre-start queue is otherwise invisible: it is bounded, and a caller that keeps hitting that
    // bound during a slow boot is exactly the condition worth surfacing.
    queueDepth: () => queued.length,
    clientCount: clients.size,
    // The one number that proves the registry does not leak: it must return to 0 after every settle,
    // cancelled or not. Summed across clients — requestMetrics' per-type inFlight answers a
    // different question (which request is slow) and would hide a leak in one type behind traffic
    // in another.
    inFlightCount: () => clients.all().reduce((n, client) => n + client.inFlight.size, 0),
  }
}
