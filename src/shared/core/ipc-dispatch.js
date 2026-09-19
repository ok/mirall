// One request frame, from the table lookup to the answer. Split from the router because it is the
// step that grows: the boundary validation, the cancellation token, the per-request metrics and the
// failure log all hang off it, and the router's own job is deciding which frames come here at all.
import { validateArgs } from './handler-table.js'
import { INVALID_ARGUMENT } from '../contract/errors.js'
import { createCancellation } from './cancellation.js'

export function createDispatcher({ table, metrics, countFailure, respond, log, logRequestFailure }) {
  return function dispatch(client, msg) {
    const entry = table.get(msg.type)
    if (!entry) {
      // warn, not debug: the renderer asking for a handler that does not exist is a contract
      // break, and at the default level a debug line means nobody ever learns of it.
      log.warn('req-unknown', msg.type)
      countFailure('unknown-command', 'NOT_FOUND')
      respond(msg.id, null, `Unknown command: ${msg.type}`, 'NOT_FOUND', null, client)
      return
    }
    // Trace the whole renderer↔worker command flow at debug level so verbose
    // logging shows what the UI is actually driving, with per-request timing.
    const label = msg.id != null ? `${msg.type} #${msg.id}` : msg.type

    // Validated from the contract's arg shape before the handler sees it, so a malformed payload is
    // a refusal at the boundary rather than an internal error from deep in a handler body.
    const invalid = validateArgs(entry.spec.args, msg)
    if (invalid) {
      log.warn('req-invalid', label, invalid)
      countFailure(msg.type, INVALID_ARGUMENT)
      respond(msg.id, null, invalid, INVALID_ARGUMENT, null, client)
      return
    }

    log.debug('req', label)
    const settle = metrics.begin(msg.type)
    // A request with no id cannot be cancelled — nothing can name it — so it gets no token and an
    // event-style frame costs nothing.
    const cancellation = msg.id != null ? createCancellation() : null
    // On the CLIENT, not the router: ids are caller-minted and every caller starts at 1, so the id
    // alone is not a key. Two clients with a request 7 each is the ordinary case, and one
    // cancelling must not abort the other's.
    if (cancellation) client.inFlight.set(msg.id, cancellation)
    // The settle path is the SINGLE owner of removal. Deleting on abort instead would drop the entry
    // while the handler is still running, and a second cancel for that id would then read as
    // "already settled" and silently do nothing.
    const done = () => { if (msg.id != null) client.inFlight.delete(msg.id) }
    // `new Promise(resolve => resolve(...))`, not `Promise.resolve(...)`: the latter EVALUATES the
    // handler before the promise exists, so a synchronous throw would unwind into the frame-parse
    // catch — unanswered, uncounted, in-flight never settled.
    new Promise((resolve) => resolve(entry.fn(msg, { id: msg.id ?? null, signal: cancellation?.signal ?? null, client }))).then(
      (data) => { done(); log.debug('res', label, 'ok', `${settle(true)}ms`); respond(msg.id, data, undefined, undefined, null, client) },
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
        respond(msg.id, null, err?.message, code, err?.fields || null, client)
      }
    )
  }
}
