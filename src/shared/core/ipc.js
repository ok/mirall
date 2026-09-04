// The worker end of the renderer↔worker pipe: NDJSON request/response framing with a
// handler table, `event:*` pushes, and the coalesced reconcile hint bus. Frames arriving
// before start() are queued so no request is lost during boot.
import { createLogger, fields } from './logger.js'
import { createHintBus } from '../state/hints.js'
import { Scope } from '../contract/scope.js'
import { EXPECTED_CODES as CONTRACT_EXPECTED_CODES, INVALID_ARGUMENT } from '../contract/errors.js'
import { IPC_MAX_FRAME_BYTES } from '../contract/limits.js'
import { FRAME } from '../contract/frames.js'
import { AppError, ErrorCodes } from './errors.js'
import { createCancellation } from './cancellation.js'
import { createHandlerTable, validateArgs } from './handler-table.js'
import { createRequestMetrics } from './request-metrics.js'

const log = createLogger('ipc')

const NEWLINE = 0x0A
const EMPTY = Buffer.alloc(0)

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

export function scopeForEvent(type, payload = {}) {
  const toScope = POKE_SCOPE[type]
  return toScope ? toScope(payload) : null
}

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

// Per-request timing and outcomes. The router already had the numbers and discarded them; keeping
// them is what makes a claim like "one member change costs eleven round-trips" checkable instead of
// estimated.
const requestMetrics = createRequestMetrics()

export function getRequestMetrics() {
  return requestMetrics.snapshot()
}

export function resetRequestMetrics() {
  requestMetrics.reset()
}

// Ordered key=value rather than JSON: the transport is a console line forwarded to main and read by
// a human with grep. The router is the one place with enough structure to be worth it — converting
// the other 400 positional call sites is a separate, mechanical change.
// Every part of the line is key=value now, message included — the previous format concatenated the
// type and id into one `req=boom #2` token, which is unreadable to anything but a human. The error's
// own fields are spread FIRST so the router's canonical keys win a name clash.
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

export function resetRequestFailureCounters() {
  requestFailures.clear()
}

// `requests` is injectable so a test can declare the small vocabulary it exercises. Production
// passes nothing and gets the real contract, which is what makes an unknown handler name a boot
// failure rather than a 404 discovered in the field.
export function createIPC(pipe, { requests, maxFrameBytes = IPC_MAX_FRAME_BYTES, maxQueuedFrames = MAX_QUEUED_FRAMES } = {}) {
  // The table owns the request metadata; `handle` below is a thin shim onto it so all 85 existing
  // registrations keep working while domains move onto register(ipc, deps) one at a time.
  const table = createHandlerTable(requests ? { requests } : {})
  // One entry per dispatched-but-unsettled request, keyed by the caller's id. Not a new unbounded
  // structure: it holds exactly the set the pending promise chain already holds, and makes it
  // addressable so a cancel frame can reach it. A cap belongs with IPC flow control, not here.
  //
  // Per-instance, like `queued` and unlike the metrics counters: it is control state, so a second
  // router in the same process (every test that builds one) must not be able to abort the first
  // one's work. getInFlightCount() reaches it through the singleton, the way getQueueDepth() does.
  const inFlight = new Map()
  const queued = []
  let ready = false
  let buffer = EMPTY
  // After an oversized frame the bytes still arriving belong to the frame being discarded. Without
  // this, the TAIL of that frame is parsed as though it were a fresh one — turning one oversized
  // frame into one forged frame, which is worse than the unbounded buffer it replaces.
  let skipping = false
  let bootstrapResolve
  const bootstrapPromise = new Promise((resolve) => { bootstrapResolve = resolve })

  pipe.on('data', (chunk) => {
    // Bytes, not text. `buffer += chunk.toString()` decoded every chunk independently, so a chunk
    // ending mid-sequence turned the split character into U+FFFD on both halves — and U+FFFD is
    // legal JSON, so the frame parsed cleanly and the handler ran on a corrupted string (a space
    // name, a path, a memo, the bootstrap frame's downloadFolder). Splitting on the newline BYTE is
    // exact: 0x0A cannot occur inside a multi-byte UTF-8 sequence, so every complete line is
    // complete UTF-8. It is also the only portable answer here — Bare has no TextDecoder, and its
    // apparent `string_decoder` is a devDependency artefact absent from a production install.
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

    // Resync first: drop bytes until the newline that ends the frame already given up on.
    if (skipping) {
      const nl = buffer.indexOf(NEWLINE)
      if (nl === -1) { buffer = EMPTY; return }
      buffer = Buffer.from(buffer.subarray(nl + 1))
      skipping = false
    }

    // Refused on SIZE, before the frame is ever materialised as a JSON string — and before any
    // newline arrives to make it a parse failure instead. The `indexOf` test is what scopes the cap
    // to ONE FRAME rather than to the read buffer: a chunk carrying many small frames can exceed
    // the cap in total and every one of them is still legitimate.
    //
    // Measured in BYTES — the same number the sender computed with Buffer.byteLength. The old
    // `.length` on a decoded string was UTF-16 code units, deliberately lenient because a
    // multi-byte frame measured smaller than the sender believed; exact is strictly better, since
    // no frame the sender considers legal is refused and the memory bound is now the real one.
    if (buffer.length > maxFrameBytes && buffer.indexOf(NEWLINE) === -1) {
      log.warn('oversized frame discarded:', buffer.length, 'bytes exceeds', maxFrameBytes)
      countFailure('oversized-frame', INVALID_ARGUMENT)
      buffer = EMPTY
      skipping = true
      return
    }

    // The leftover is committed BEFORE dispatching, so a handler that throws cannot cause the
    // frames after it to be re-read from a stale buffer.
    const lastNl = buffer.lastIndexOf(NEWLINE)
    // Copied because `buffer` may still BE the caller's chunk, which the pipe is free to reuse
    // once this handler returns.
    if (lastNl === -1) { buffer = Buffer.from(buffer); return }
    const complete = buffer
    buffer = lastNl + 1 === complete.length ? EMPTY : Buffer.from(complete.subarray(lastNl + 1))

    let start = 0
    while (start <= lastNl) {
      const nl = complete.indexOf(NEWLINE, start)
      const line = complete.subarray(start, nl)
      start = nl + 1
      if (line.length === 0) continue
      try {
        const msg = JSON.parse(line.toString('utf8'))
        if (msg && msg.type === FRAME.BOOTSTRAP) {
          if (bootstrapResolve) {
            bootstrapResolve(msg)
            bootstrapResolve = null
          }
          continue
        }
        // Before the `ready` test on purpose: a cancel dispatched through the queue would be
        // processed AFTER the request it cancels, so a slow boot — the one moment cancelling is
        // most useful — is the one moment it would not work.
        if (msg && msg.type === FRAME.CANCEL) {
          cancel(msg.id)
          continue
        }
        if (ready) {
          dispatch(msg)
        } else if (queued.length >= maxQueuedFrames) {
          // Refused, not silently dropped: a caller awaiting a response must not hang on a promise
          // nothing will ever settle. Keeping the OLDEST keeps the frames most likely to be the
          // session's real first requests.
          log.warn('pre-start queue full, frame refused:', msg.type)
          countFailure(msg.type || 'unknown-command', INVALID_ARGUMENT)
          respond(msg.id, null, 'worker is still starting', INVALID_ARGUMENT)
        } else {
          queued.push(msg)
        }
      } catch (err) {
        // A malformed frame is recoverable — skip the line and keep reading
        // (NDJSON resync). Debug-level so a stray/partial frame doesn't spam the
        // console; enable verbose to diagnose genuine IPC corruption.
        log.debug('skipped unparseable frame:', err.message)
      }
    }
  })

  function dispatch(msg) {
    const entry = table.get(msg.type)
    if (!entry) {
      // warn, not debug: the renderer asking for a handler that does not exist is a contract
      // break, and at the default level a debug line means nobody ever learns of it.
      log.warn('req-unknown', msg.type)
      countFailure('unknown-command', 'NOT_FOUND')
      respond(msg.id, null, `Unknown command: ${msg.type}`, 'NOT_FOUND')
      return
    }
    // Trace the whole renderer↔worker command flow at debug level so verbose
    // logging shows what the UI is actually driving, with per-request timing.
    const label = msg.id != null ? `${msg.type} #${msg.id}` : msg.type

    // Validated from the contract's arg shape before the handler sees it: four `typeof msg.` checks
    // were spread across 85 handlers, so a malformed payload used to surface as an internal error
    // from somewhere deep in a handler body instead of a refusal at the boundary.
    const invalid = validateArgs(entry.spec.args, msg)
    if (invalid) {
      log.warn('req-invalid', label, invalid)
      countFailure(msg.type, INVALID_ARGUMENT)
      respond(msg.id, null, invalid, INVALID_ARGUMENT)
      return
    }

    log.debug('req', label)
    const settle = requestMetrics.begin(msg.type)
    // A request with no id cannot be cancelled — nothing can name it — so it gets no token and an
    // event-style frame costs nothing.
    const cancellation = msg.id != null ? createCancellation() : null
    if (cancellation) inFlight.set(msg.id, cancellation)
    // The settle path is the SINGLE owner of removal. Deleting on abort instead would drop the entry
    // while the handler is still running, and a second cancel for that id would then read as
    // "already settled" and silently do nothing.
    const done = () => { if (msg.id != null) inFlight.delete(msg.id) }
    // `new Promise(resolve => resolve(...))`, not `Promise.resolve(...)`: the latter EVALUATES the
    // handler before the promise exists, so a handler that throws synchronously unwound into the
    // frame-parse catch around dispatch() — reported as an unparseable frame at debug, never
    // answered (the caller hung to the renderer's 30s timeout), never counted, and with the
    // in-flight metric already incremented and no settle to match it.
    new Promise((resolve) => resolve(entry.fn(msg, { id: msg.id ?? null, signal: cancellation?.signal ?? null }))).then(
      (data) => { done(); log.debug('res', label, 'ok', `${settle(true)}ms`); respond(msg.id, data) },
      (err) => {
        done()
        const ms = settle(false)
        const code = err?.code || 'UNKNOWN'
        countFailure(msg.type, code)
        // A failing request logs at warn so it survives the default level. Successes stay at debug:
        // they are the verbose trace, and only wanted when someone asked for it.
        logRequestFailure(log, {
          req: msg.type, id: msg.id ?? null, code, ms,
          message: err?.message || String(err),
          extra: err?.fields || null,
        })
        respond(msg.id, null, err?.message, code, err?.fields || null)
      }
    )
  }

  // Best-effort and idempotent: a cancel for an id that has already settled, was never sent, or was
  // already cancelled is a no-op, because the renderer fires it without waiting to learn which.
  function cancel(id) {
    if (id == null) return
    // The queue first. A frame that has not been dispatched has no token to abort, and leaving it
    // queued means the cancel is ignored and the work runs in full the moment start() fires.
    const queuedAt = queued.findIndex((m) => m && m.id === id)
    if (queuedAt !== -1) {
      const [dropped] = queued.splice(queuedAt, 1)
      log.debug('cancel', id, `(${dropped.type}, dropped from the pre-start queue)`)
      // Answered, unlike an in-flight cancel: nothing else ever will, and a caller that has not yet
      // discarded its pending entry would otherwise wait out the renderer's full request timeout.
      respond(id, null, 'cancelled before dispatch', ErrorCodes.ECANCELLED)
      return
    }
    const entry = inFlight.get(id)
    if (!entry) { log.debug('cancel', id, '(already settled or unknown)'); return }
    log.debug('cancel', id, '(in flight)')
    entry.abort(new AppError(ErrorCodes.ECANCELLED, 'cancelled by the caller'))
  }

  // Every outstanding request, aborted before the data layer closes under it. Without this a handler
  // parked on a bee read that is about to be closed throws a "session closed" error into the crash
  // backstop's fault window; aborting first routes it through the ECANCELLED path the router already
  // treats as expected.
  function abortAll(reason) {
    if (!inFlight.size) return 0
    const n = inFlight.size
    log.debug('aborting', n, 'in-flight requests')
    for (const entry of [...inFlight.values()]) {
      entry.abort(new AppError(ErrorCodes.ECANCELLED, reason || 'worker is shutting down'))
    }
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

  function respond(id, data, error, code, errorFields) {
    if (!id) return
    const msg = error
      ? { id, type: 'response', error, code, ...(errorFields ? { fields: errorFields } : {}) }
      : { id, type: 'response', data }
    pipe.write(JSON.stringify(msg) + '\n')
  }

  const hintBus = createHintBus((t, p) => pipe.write(JSON.stringify({ type: t, ...p }) + '\n'))

  function emit(type, payload = {}) {
    // Log server-pushed events, but skip the high-frequency streams (per-chunk
    // transfer/publish progress + decoration frames) so they don't flood the console.
    if (!type.endsWith('-progress') && type !== 'event:decoration' && type !== 'event:awareness') log.debug('emit', type)
    pipe.write(JSON.stringify({ type, ...payload }) + '\n')
    const scope = scopeForEvent(type, payload)
    if (scope) hintBus.hint(scope)
  }

  function handle(type, fn) {
    table.register(type, fn)
  }

  function start() {
    ready = true
    for (const msg of queued) dispatch(msg)
    queued.length = 0
  }

  ipcSingleton.bootstrapPromise = bootstrapPromise
  ipcSingleton.queueDepth = () => queued.length
  ipcSingleton.inFlightCount = () => inFlight.size
  return { handle, emit, respond, start, cancel, abortAll }
}

const ipcSingleton = { bootstrapPromise: null, queueDepth: null, inFlightCount: null }

// The pre-start queue is otherwise invisible: it is bounded now, and a caller that keeps hitting
// that bound during a slow boot is exactly the condition worth surfacing.
export function getQueueDepth() {
  return ipcSingleton.queueDepth ? ipcSingleton.queueDepth() : 0
}

// The one number that proves the registry does not leak: it must return to 0 after every settle,
// cancelled or not. requestMetrics' per-type inFlight answers a different question (which request is
// slow) and would hide a leak in one type behind traffic in another.
export function getInFlightCount() {
  return ipcSingleton.inFlightCount ? ipcSingleton.inFlightCount() : 0
}

export function getBootstrapPromise() {
  if (!ipcSingleton.bootstrapPromise) {
    throw new Error('IPC not initialized; call createIPC(pipe) first')
  }
  return ipcSingleton.bootstrapPromise
}
