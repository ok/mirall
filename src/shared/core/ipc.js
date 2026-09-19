// The worker end of the renderer↔worker pipe: NDJSON request/response framing with a
// handler table, `event:*` pushes, and the coalesced reconcile hint bus. Frames arriving
// before start() are queued so no request is lost during boot.
import { createLogger, fields } from './logger.js'
import { createHintBus } from './hints.js'
import { Scope } from '../contract/scope.js'
import { EXPECTED_CODES as CONTRACT_EXPECTED_CODES, INVALID_ARGUMENT } from '../contract/errors.js'
import { IPC_MAX_FRAME_BYTES } from '../contract/limits.js'
import { FRAME } from '../contract/ipc-frames.js'
import { TARGETED_EVENTS } from '../contract/events.js'
import { createClientRegistry } from './ipc-client.js'
import { createDispatcher } from './ipc-dispatch.js'
import { checkProtocolCompatibility, protocolMismatchMessage } from '../contract/protocol-compat.js'
import { AppError } from './errors.js'
import { CODES } from '../contract/errors.js'
import { createHandlerTable } from './handler-table.js'
import { createRequestMetrics } from './request-metrics.js'
import { createFrameReader } from './frame-reader.js'

const log = createLogger('ipc')

// Fan a coalesced `event:reconcile` out of a POKE so its view re-derives through the level-triggered
// reconcile channel. The named events stay on the wire as the emit-site API (and as flow-test /
// debugging observables); the reconcile-driven hooks (useFiles, useShareFiles, useMembers, useShares,
// useSpaces) no longer subscribe to them. Every row here must have a consumer matching that scope
// kind, and every hook that re-derives on a hint must have its poke sources mapped here.
// event:member-joined is deliberately unmapped: it fires pre-persist; members-updated (post-persist)
// is the poke. Owned/foreign mount-status both map to the shares scope (both persist a durable
// mount.status the consumer re-derives, and the listings they re-read carry lastError, so the
// transient paused-error state arrives with them — neither consumer needs a named subscription).
const POKE_SCOPE = {
  'event:files-updated': (p) => (p.spaceId ? Scope.files(p.spaceId) : null),
  'event:shares-updated': (p) => (p.spaceId ? Scope.shares(p.spaceId) : null),
  // shareId may be absent (a space-wide poke) — the hint is then a wildcard on the share
  // axis and matches every share view in the space (scope-match contract).
  'event:share-files-updated': (p) => (p.spaceId ? Scope.shareFiles(p.spaceId, p.shareId) : null),
  'event:members-updated': (p) => (p.spaceId ? Scope.members(p.spaceId) : null),
  'event:mirrors-updated': (p) => (p.spaceId ? Scope.mirrors(p.spaceId, p.shareId) : null),
  'event:member-left': (p) => (p.spaceId ? Scope.members(p.spaceId) : null),
  'event:member-avatar-updated': (p) => (p.spaceId ? Scope.members(p.spaceId) : null),
  'event:member-join-request': (p) => (p.spaceId ? Scope.joinRequests(p.spaceId) : null),
  'event:join-requests-updated': (p) => (p.spaceId ? Scope.joinRequests(p.spaceId) : null),
  'event:foreign-folder-mount-status': (p) => (p.spaceId ? Scope.shares(p.spaceId) : null),
  'event:owned-folder-mount-status': (p) => (p.spaceId ? Scope.shares(p.spaceId) : null),
  'event:audit-updated': () => Scope.audit(),
}

/** @internal */
export function scopeForEvent(type, payload = {}) {
  const toScope = POKE_SCOPE[type]
  return toScope ? toScope(payload) : null
}

// Ordinary control flow rather than faults: the user cancelled, or a bounded read gave up as
// designed. Logging these at warn would teach the reader to ignore the level. Both are genuinely
// thrown — ECANCELLED by the overlay backend on an aborted read, PREVIEW_CANCELLED by walk-disk.js.
const EXPECTED = new Set(CONTRACT_EXPECTED_CODES)

const TARGETED = new Set(TARGETED_EVENTS)

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
export function createIPC(pipe, { requests, maxFrameBytes = IPC_MAX_FRAME_BYTES, maxQueuedFrames = MAX_QUEUED_FRAMES } = {}) {
  // The table owns the request metadata; `handle` is a thin shim onto it so registrations keep
  // working while domains move onto register(ipc, deps).
  const table = createHandlerTable(requests ? { requests } : {})
  // Per-instance, like the queue and unlike the metrics counters: a client set is control state,
  // so a second router in the same process (every test that builds one) must not be able to abort
  // the first one's work.
  const clients = createClientRegistry({
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
  let bootstrapResolve
  let bootstrapReject
  const bootstrapPromise = new Promise((resolve, reject) => {
    bootstrapResolve = resolve
    bootstrapReject = reject
  })
  // A rejection nobody is awaiting yet is an unhandled rejection the crash backstop would count.
  // The single production awaiter attaches before any frame can arrive, but a test router that
  // never awaits must not take the process down with it.
  bootstrapPromise.catch(() => {})

  // The protocol check happens before any other field is read: a frame from a host on a different
  // wire is refused whole, rather than defaulted field by field into a degraded worker. Resolver
  // and rejecter are nulled together, so a second frame — a host retrying — cannot re-settle it.
  function settleBootstrap(msg) {
    if (!bootstrapResolve) return
    const compat = checkProtocolCompatibility(msg)
    if (compat.ok) bootstrapResolve(msg)
    else bootstrapReject(new AppError(CODES.PROTOCOL_MISMATCH, protocolMismatchMessage(compat)))
    bootstrapResolve = null
    bootstrapReject = null
  }

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
    if (msg && msg.type === FRAME.BOOTSTRAP) {
      // Only from the first client. The frame carries the identity KEK and the storage path, so a
      // peer that attached later must not be able to settle — or re-settle — the worker's boot.
      if (client === primary) settleBootstrap(msg)
      else log.warn('bootstrap frame from a non-primary client, ignored')
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

  const dispatch = createDispatcher({ table, metrics: requestMetrics, countFailure, respond, log, logRequestFailure })

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
    const entry = client.inFlight.get(id)
    if (!entry) { log.debug('cancel', id, '(already settled or unknown)'); return }
    log.debug('cancel', id, '(in flight)')
    entry.abort(new AppError(CODES.ECANCELLED, 'cancelled by the caller'))
  }

  // Every outstanding request, aborted before the data layer closes under it. Without this a handler
  // parked on a bee read that is about to be closed throws a "session closed" error into the crash
  // backstop's fault window; aborting first routes it through the ECANCELLED path the router already
  // treats as expected.
  function abortClient(client, reason) {
    const n = client.inFlight.size
    if (!n) return 0
    for (const entry of [...client.inFlight.values()]) {
      entry.abort(new AppError(CODES.ECANCELLED, reason))
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

  // Through emit(), not straight at a pipe: the hint bus was the second write site on the wire, and
  // a second site is one every later frame-level change has to remember. There is no recursion —
  // scopeForEvent('event:reconcile') is null.
  const hintBus = createHintBus((t, p) => emit(t, p))

  // The high-frequency streams: per-chunk transfer/publish progress, decoration and awareness
  // frames. Named because more than one rule keys off the same set.
  const isHighRate = (type) =>
    type.endsWith('-progress') || type === 'event:decoration' || type === 'event:awareness'

  // emit(type, payload)          → every client
  // emit(type, payload, { to })  → one client, by object or by id
  //
  // One method rather than emit + emitTo: the contract guards find emit sites by parsing for a
  // callee named `emit` with the event name first (test/helpers/emit-sites.js), and a second
  // spelling would hide every targeted event from "is every declared event emitted somewhere".
  function emit(type, payload = {}, { to = null } = {}) {
    if (TARGETED.has(type) && to == null) {
      // One caller's progress must never land in another's UI. Dropped with a warn rather than
      // thrown: leave-progress fires from a teardown that outlives its own request, and a throw
      // there is an unhandled rejection inside the crash backstop's fault window. The static guard
      // (test/invariants/targeted-events.test.js) is what stops a new call site shipping like this.
      log.warn('targeted event emitted with no target, dropped:', type)
      return
    }
    if (!isHighRate(type)) log.debug('emit', type)
    const line = JSON.stringify({ type, ...payload }) + '\n'
    if (to != null) {
      // A target that has since disconnected is a silent no-op, not an error: the operation it was
      // reporting on outlives the client that asked for it.
      clients.resolve(to)?.write(line)
      return
    }
    for (const client of clients.all()) client.write(line)
    // Hints fan out of broadcasts only: a targeted event is one caller's progress and says nothing
    // about state anyone else re-derives.
    const scope = scopeForEvent(type, payload)
    if (scope) hintBus.hint(scope)
  }

  function handle(type, fn) {
    table.register(type, fn)
  }

  function start() {
    ready = true
    for (const { client, msg } of queued) dispatch(client, msg)
    queued.length = 0
    clients.goLive()
  }

  // The pipe handed to createIPC is the first client's. Keeping the one-pipe signature is what
  // makes this change reviewable: every existing caller — production and the whole test suite —
  // gets the behaviour it had, and the multi-client paths are reached through attach() alone.
  const primary = pipe ? clients.attach(pipe) : null

  return {
    handle, emit, respond, start, cancel, abortAll,
    attach: (p, opts) => clients.attach(p, opts),
    detach: (client, reason) => clients.detach(client, reason),
    onClientAttach: (fn) => clients.onAttach(fn),
    onClientDisconnect: (fn) => clients.onDisconnect(fn),
    primary,
    bootstrapPromise,
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
