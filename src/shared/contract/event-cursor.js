// Where a client has read to on the worker's event stream, and what a reconnect means. The stream
// is numbered per worker PROCESS: an epoch names the generation and a seq the frame within it, so a
// cursor is only meaningful against the epoch that issued it.
//
// Pure and import-free, because three runtimes hold one: the renderer instantiates it today (it is
// the only process that parses every worker frame), main takes it over when the byte relay goes,
// and the CLI ports it.

/** @typedef {{ epoch: string | null, since: number }} Cursor */
/** @typedef {{ epoch: string, head: number }} StreamCoordinates */
/** @typedef {{ epoch: string, head: number, gap: boolean, replayed: number }} ResumeAnswer */
/** @typedef {'first' | 'resume' | 'resync'} ArrivalVerdict */
/** @typedef {'caught-up' | 'replayed' | 'resync'} ResumeOutcome */
/**
 * @typedef {{
 *   observe: (frame: { seq?: number }) => void,
 *   connected: () => void,
 *   cursor: () => Cursor,
 *   arrived: (coords: StreamCoordinates) => ArrivalVerdict,
 *   resumed: (answer: ResumeAnswer) => ResumeOutcome,
 * }} EventCursor
 */

/** @returns {EventCursor} */
export function createEventCursor() {
  /** @type {string | null} */
  let epoch = null
  let since = 0
  // Whether this client has been live on a worker it has no coordinates for. A greeting is emitted
  // per connection, so a client that came up over one already established never sees one and holds
  // no epoch — which is a different state from having never been connected, and the two take
  // opposite branches on the next greeting.
  let ungreeted = false
  // One resume per cursor POSITION, not per generation: a second resume from the same cursor asks
  // for frames the first already delivered, while a cursor that has moved on is a different
  // question — which is exactly what a later outage in the same generation asks.
  /** @type {string | null} */
  let resumedFrom = null

  const mark = () => `${epoch}@${since}`

  return {
    // A frame with no ordinal is a no-op. Ordinals only move forward — replayed frames arrive after
    // the live ones the client already holds, and winding the cursor back would ask for them again
    // on the next reconnect. Matched responses never reach here: the channel settles those against
    // their pending request and returns before the stream sees them, which is why a response is a
    // no-op by construction rather than by the ordinal test below.
    /** @param {{ seq?: number }} frame */
    observe(frame) {
      const seq = frame?.seq
      if (typeof seq === 'number' && seq > since) since = seq
    },

    // Live on a worker that did not greet us. Everything this client holds came from that
    // generation, so the next greeting it sees is a different process and a resync, not a first
    // connection.
    connected() {
      if (epoch === null) ungreeted = true
    },

    cursor: () => ({ epoch, since }),

    // What a greeting means for a client that has been listening. A client that has never been
    // connected has missed nothing and starts at the worker's head. The same epoch means the worker
    // outlived the connection, so the gap is replayable. A different epoch is a new process, whose
    // ring holds frames this client never asked about, and only a resync is honest.
    /** @param {StreamCoordinates} coords @returns {ArrivalVerdict} */
    arrived(coords) {
      if (epoch === null) {
        epoch = coords.epoch
        since = coords.head
        return ungreeted ? 'resync' : 'first'
      }
      if (coords.epoch === epoch) {
        const at = mark()
        if (resumedFrom === at) return 'first'
        resumedFrom = at
        return 'resume'
      }
      epoch = coords.epoch
      since = coords.head
      resumedFrom = null
      return 'resync'
    },

    // The worker's answer to a resume. A gap collapses to a resync and adopts the worker's
    // coordinates, so the next reconnect asks from somewhere real rather than from a cursor the
    // worker has already refused once.
    /** @param {ResumeAnswer} answer @returns {ResumeOutcome} */
    resumed(answer) {
      if (answer.gap) {
        epoch = answer.epoch
        since = answer.head
        resumedFrom = null
        return 'resync'
      }
      return answer.replayed > 0 ? 'replayed' : 'caught-up'
    },
  }
}
