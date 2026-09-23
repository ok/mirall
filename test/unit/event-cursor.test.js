import test from 'brittle'
import { createEventCursor } from '../../src/shared/contract/event-cursor.js'

// Where a client has read to, and what a greeting from the worker means for it. The whole client
// half of the replay contract is here, so every branch of it is driven without a pipe.

test('the cursor only ever moves forward', (t) => {
  const c = createEventCursor()
  c.arrived({ epoch: 'e1', head: 0 })
  c.observe({ seq: 3 })
  c.observe({ seq: 2 })
  t.alike(c.cursor(), { epoch: 'e1', since: 3 }, 'an older ordinal does not wind it back')
  c.observe({ id: 7, type: 'response' })
  t.alike(c.cursor(), { epoch: 'e1', since: 3 }, 'a frame with no ordinal is a no-op')
})

test('a first arrival starts at the head and has missed nothing', (t) => {
  const c = createEventCursor()
  t.is(c.arrived({ epoch: 'e1', head: 12 }), 'first')
  t.alike(c.cursor(), { epoch: 'e1', since: 12 })
})

// The greeting is targeted, so it takes an ordinal but is never ringed: counting it would make the
// client ask from one frame further on than the worker can answer for.
test('the greeting reports the head it had BEFORE its own ordinal', (t) => {
  const c = createEventCursor()
  c.observe({ type: 'event:worker-ready', seq: 13 })
  c.arrived({ epoch: 'e1', head: 12 })
  t.alike(c.cursor(), { epoch: 'e1', since: 12 }, 'the head wins over the greeting frame itself')
})

test('the same stream is resumable once per cursor position', (t) => {
  const c = createEventCursor()
  c.arrived({ epoch: 'e1', head: 0 })
  c.observe({ seq: 5 })
  t.is(c.arrived({ epoch: 'e1', head: 9 }), 'resume', 'the worker outlived the connection')
  t.alike(c.cursor(), { epoch: 'e1', since: 5 }, 'and the resume asks from where we actually got to')
  t.is(c.resumed({ epoch: 'e1', head: 9, gap: false, replayed: 4 }), 'replayed')
  t.is(c.arrived({ epoch: 'e1', head: 9 }), 'first', 'asking again from the same cursor would replay what we hold')
})

// REGRESSION (FIX-CURSOR-1: the guard was keyed on the worker generation, so the FIRST resume
// disarmed every later one. A socket that dropped a second time reported 'first', which neither
// replays nor resyncs and does not move the cursor, so the frames of that second outage were lost
// with no signal.)
test('REGRESSION (FIX-CURSOR-1: a later outage in the same generation is resumed, not swallowed)', (t) => {
  const c = createEventCursor()
  c.arrived({ epoch: 'e1', head: 0 })
  t.is(c.arrived({ epoch: 'e1', head: 100 }), 'resume', 'the first drop')
  t.is(c.resumed({ epoch: 'e1', head: 100, gap: false, replayed: 3 }), 'replayed')
  // The client keeps listening, so its cursor moves on past everything that resume delivered.
  c.observe({ seq: 900 })
  t.is(c.arrived({ epoch: 'e1', head: 1200 }), 'resume', 'the second drop asks for 901-1200')
  t.alike(c.cursor(), { epoch: 'e1', since: 900 })
})

// REGRESSION (FIX-CURSOR-2: a renderer that came up over a worker already running never receives a
// greeting, so it held no epoch. The next greeting — a NEW process — read as a first connection,
// and the client kept every answer the dead generation gave it, re-armed nothing, and left every
// entry the exit had faulted showing that error for the rest of the session.)
test('REGRESSION (FIX-CURSOR-2: a client that was live but ungreeted resyncs on the next greeting)', (t) => {
  const c = createEventCursor()
  c.connected()
  t.alike(c.cursor(), { epoch: null, since: 0 }, 'it still has no coordinates to resume from')
  t.is(c.arrived({ epoch: 'e2', head: 40 }), 'resync')
  t.alike(c.cursor(), { epoch: 'e2', since: 40 }, 'and it adopts the stream it was just told about')
})

test('a client that has never been connected is still a first arrival', (t) => {
  const c = createEventCursor()
  t.is(c.arrived({ epoch: 'e1', head: 40 }), 'first')
})

// The marker names a coordinate on a stream, so the stream it named going away takes it with it.
test('adopting a new stream re-arms the resume', (t) => {
  const c = createEventCursor()
  c.arrived({ epoch: 'e1', head: 0 })
  t.is(c.arrived({ epoch: 'e1', head: 4 }), 'resume')
  t.is(c.arrived({ epoch: 'e2', head: 0 }), 'resync')
  t.is(c.arrived({ epoch: 'e2', head: 7 }), 'resume', 'the new stream has its own resume to spend')
})

test('a different stream is a new process and only a resync is honest', (t) => {
  const c = createEventCursor()
  c.arrived({ epoch: 'e1', head: 0 })
  c.observe({ seq: 40 })
  t.is(c.arrived({ epoch: 'e2', head: 3 }), 'resync')
  t.alike(c.cursor(), { epoch: 'e2', since: 3 }, 'it adopts the new stream rather than keeping a cursor into a dead one')
})

test('a gap collapses to a resync and adopts what the worker reported', (t) => {
  const c = createEventCursor()
  c.arrived({ epoch: 'e1', head: 0 })
  c.observe({ seq: 2 })
  c.arrived({ epoch: 'e1', head: 900 })
  t.is(c.resumed({ epoch: 'e1', head: 900, gap: true, replayed: 0 }), 'resync')
  t.alike(c.cursor(), { epoch: 'e1', since: 900 })
})

test('nothing replayed and no gap is simply caught up', (t) => {
  const c = createEventCursor()
  c.arrived({ epoch: 'e1', head: 0 })
  c.arrived({ epoch: 'e1', head: 0 })
  t.is(c.resumed({ epoch: 'e1', head: 0, gap: false, replayed: 0 }), 'caught-up')
})
