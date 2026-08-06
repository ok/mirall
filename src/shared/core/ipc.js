// The worker end of the renderer↔worker pipe: NDJSON request/response framing with a
// handler table, `event:*` pushes, and the coalesced reconcile hint bus. Frames arriving
// before start() are queued so no request is lost during boot.
import { createLogger } from './logger.js'
import { createHintBus } from '../state/hints.js'
import { Scope } from '../state/scope.js'

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

export function createIPC(pipe) {
  const handlers = new Map()
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
    const handler = handlers.get(msg.type)
    if (!handler) {
      log.debug('req', msg.type, '— no handler')
      respond(msg.id, null, `Unknown command: ${msg.type}`, 'NOT_FOUND')
      return
    }
    // Trace the whole renderer↔worker command flow at debug level so verbose
    // logging shows what the UI is actually driving, with per-request timing.
    const label = msg.id != null ? `${msg.type} #${msg.id}` : msg.type
    const started = Date.now()
    log.debug('req', label)
    Promise.resolve(handler(msg)).then(
      (data) => { log.debug('res', label, 'ok', `${Date.now() - started}ms`); respond(msg.id, data) },
      (err) => { log.debug('res', label, 'ERROR', err.message, `${Date.now() - started}ms`); respond(msg.id, null, err.message, err.code || 'UNKNOWN') }
    )
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
    handlers.set(type, fn)
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
