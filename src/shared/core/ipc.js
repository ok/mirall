// The worker end of the renderer↔worker pipe: NDJSON request/response framing with a
// handler table, `event:*` pushes, and the coalesced reconcile hint bus. Frames arriving
// before start() are queued so no request is lost during boot.
import { createLogger } from './logger.js'
import { createHintBus } from '../state/hints.js'
import { Scope } from '../contract/scope.js'
import { EXPECTED_CODES as CONTRACT_EXPECTED_CODES, INVALID_ARGUMENT } from '../contract/errors.js'
import { createHandlerTable, validateArgs } from './handler-table.js'
import { createRequestMetrics } from './request-metrics.js'

const log = createLogger('ipc')

// Fan a coalesced `event:reconcile` out of a POKE so its view re-derives through the level-triggered
// reconcile channel. The named events stay on the wire as the emit-site API (and as flow-test /
// debugging observables); the reconcile-driven hooks (useFiles, useShareFiles, useMembers, useShares,
// useSpaces) no longer subscribe to them. Every row here must have a consumer matching that scope
// kind, and every hook that re-derives on a hint must have its poke sources mapped here.
// event:member-joined is deliberately unmapped: it fires pre-persist; members-updated (post-persist)
// is the poke. Owned/foreign mount-status both map to the shares scope (both persist a durable
// mount.status the consumer re-derives); useOwnedMount keeps a named subscription for the transient
// paused-error state, which owned-folder:get doesn't carry.
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
function logRequestFailure(log, { req, code, ms, message }) {
  const line = `req-failed req=${req} code=${code} ms=${ms} — ${message}`
  if (EXPECTED.has(code)) log.debug(line)
  else log.warn(line)
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
export function createIPC(pipe, { requests } = {}) {
  // The table owns the request metadata; `handle` below is a thin shim onto it so all 85 existing
  // registrations keep working while domains move onto register(ipc, deps) one at a time.
  const table = createHandlerTable(requests ? { requests } : {})
  const queued = []
  let ready = false
  let buffer = ''
  let bootstrapResolve
  const bootstrapPromise = new Promise((resolve) => { bootstrapResolve = resolve })

  pipe.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg && msg.type === 'bootstrap') {
          if (bootstrapResolve) {
            bootstrapResolve(msg)
            bootstrapResolve = null
          }
          continue
        }
        if (ready) {
          dispatch(msg)
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
    // The second argument is the request's context. `signal` is null until cancellation is wired
    // (r07-3): the seam costs one line now and re-plumbing 86 handlers later. Every handler takes
    // one parameter today and ignores this one.
    Promise.resolve(entry.fn(msg, { id: msg.id ?? null, signal: null })).then(
      (data) => { log.debug('res', label, 'ok', `${settle(true)}ms`); respond(msg.id, data) },
      (err) => {
        const ms = settle(false)
        const code = err?.code || 'UNKNOWN'
        countFailure(msg.type, code)
        // A failing request logs at warn so it survives the default level. Successes stay at debug:
        // they are the verbose trace, and only wanted when someone asked for it.
        logRequestFailure(log, { req: label, code, ms, message: err?.message || String(err) })
        respond(msg.id, null, err?.message, code)
      }
    )
  }

  function countFailure(type, code) {
    const key = `${type}:${code}`
    if (!requestFailures.has(key) && requestFailures.size >= MAX_FAILURE_KEYS) {
      requestFailures.set('other:OVERFLOW', (requestFailures.get('other:OVERFLOW') || 0) + 1)
      return
    }
    requestFailures.set(key, (requestFailures.get(key) || 0) + 1)
  }

  function respond(id, data, error, code) {
    if (!id) return
    const msg = error
      ? { id, type: 'response', error, code }
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
  return { handle, emit, respond, start }
}

const ipcSingleton = { bootstrapPromise: null }

export function getBootstrapPromise() {
  if (!ipcSingleton.bootstrapPromise) {
    throw new Error('IPC not initialized; call createIPC(pipe) first')
  }
  return ipcSingleton.bootstrapPromise
}
