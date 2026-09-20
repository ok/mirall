// What the router notices about work that is taking too long. Ages, not just counts: the oldest
// in-flight request is the one number that identifies a wedge, and requestMetrics cannot answer it
// — maxMs only moves on settle, so a handler that never settles is invisible there by construction.
//
// Driven, not self-scheduling. Periodic work in the data layer belongs to a subsystem via
// this.timers and the router is not one, so the health monitor — which already owns the worker's
// single periodic loop — calls the sweep from its tick.
import { AppError } from './errors.js'
import { CODES } from '../contract/errors.js'
import { fields } from './logger.js'

export function createDeadlineWatch({ clients, log, now = Date.now }) {
  // The abort comes FIRST and `warned` is set LAST. Marked first, anything that throws in between —
  // a log write to a stdout that is going away — would retire the request from the sweep with the
  // enforcement never applied, for the life of the process.
  function enforce(client, id, flight, ageMs) {
    // A query is retry-safe by contract, so its deadline aborts the token. A handler that ignores
    // the signal keeps running — that is the state today, and a reported wedge is still more than
    // none. Nothing is thrown: a rejection here would land in the crash backstop's fault window and
    // could turn a slow disk into a respawn loop.
    if (flight.enforcement === 'abort') {
      flight.cancellation.abort(new AppError(CODES.TIMEOUT, `${flight.type} exceeded its ${flight.deadlineMs}ms deadline`))
    }
    log.warn('req-deadline', fields({ req: flight.type, id, client: client.id, ms: ageMs, action: flight.enforcement }))
    // Once per request: the sweep runs every second, and a wedge would otherwise print a line a
    // second for as long as it lasts.
    flight.warned = true
  }

  return {
    sweepDeadlines(at = now()) {
      let oldest = null
      for (const client of clients.all()) {
        for (const [id, flight] of client.inFlight) {
          const ageMs = at - flight.startedAt
          if (!oldest || ageMs > oldest.ageMs) oldest = { type: flight.type, id, clientId: client.id, ageMs }
          if (!flight.deadlineMs || ageMs < flight.deadlineMs || flight.warned) continue
          // Per flight, not per pass. One request whose log write fails must not skip every request
          // behind it — and must not skip every OTHER client, which a single catch around the whole
          // sweep would. The health tick's own catch stays as the outer backstop.
          try { enforce(client, id, flight, ageMs) } catch (err) {
            log.debug('deadline sweep failed for', flight.type, err?.message)
          }
        }
      }
      return oldest
    },

    inFlightAges(at = now()) {
      const out = []
      for (const client of clients.all()) {
        for (const [id, flight] of client.inFlight) {
          out.push({ type: flight.type, id, clientId: client.id, ageMs: at - flight.startedAt })
        }
      }
      return out.sort((a, b) => b.ageMs - a.ageMs)
    },
  }
}
