import test from 'brittle'
import { createEventLog } from '../helpers/event-log.js'

const ev = (type, extra = {}) => ({ type, ...extra })

test('a boot event is findable after seal, once', (t) => {
  const log = createEventLog()
  log.deliver(ev('event:membership-denied', { spaceId: 's1' }))
  log.seal()
  t.alike(log.takeFromBacklog('event:membership-denied', (m) => m.spaceId === 's1'), ev('event:membership-denied', { spaceId: 's1' }))
  t.is(log.takeFromBacklog('event:membership-denied', () => true), null, 'consumed on the first take')
})

test('the predicate filters the backlog and a miss leaves it intact', (t) => {
  const log = createEventLog()
  log.deliver(ev('event:member-join-request', { spaceId: 'a' }))
  log.deliver(ev('event:member-join-request', { spaceId: 'b' }))
  log.seal()
  t.is(log.takeFromBacklog('event:member-join-request', (m) => m.spaceId === 'zzz'), null)
  t.is(log.takeFromBacklog('event:member-join-request', (m) => m.spaceId === 'b').spaceId, 'b')
  t.is(log.takeFromBacklog('event:member-join-request', () => true).spaceId, 'a', 'the other one is still there')
})

test('nothing delivered after seal is recorded', (t) => {
  const log = createEventLog()
  log.seal()
  log.deliver(ev('event:membership-denied'))
  t.is(log.takeFromBacklog('event:membership-denied', () => true), null)
})

test('live listeners fire for every delivery, before and after seal, and unsubscribe', (t) => {
  const log = createEventLog()
  const got = []
  const off = log.on('event:x', (m) => got.push(m.n))
  log.deliver(ev('event:x', { n: 1 }))
  log.seal()
  log.deliver(ev('event:x', { n: 2 }))
  off()
  log.deliver(ev('event:x', { n: 3 }))
  t.alike(got, [1, 2])
})

test('the wildcard listener sees every type', (t) => {
  const log = createEventLog()
  const types = []
  log.on('*', (m) => types.push(m.type))
  log.deliver(ev('event:a'))
  log.deliver(ev('event:b'))
  t.alike(types, ['event:a', 'event:b'])
})

test('the backlog is capped and the summary says so', (t) => {
  const log = createEventLog({ maxBacklog: 2 })
  log.deliver(ev('event:a', { n: 1 }))
  log.deliver(ev('event:a', { n: 2 }))
  log.deliver(ev('event:a', { n: 3 }))
  log.seal()
  t.is(log.takeFromBacklog('event:a', () => true).n, 2, 'oldest dropped first')
  t.ok(log.summary().includes('1 boot event(s) dropped'))
})

test('summary names counts since spawn and the unconsumed backlog', (t) => {
  const log = createEventLog()
  log.deliver(ev('event:state'))
  log.deliver(ev('event:state'))
  log.deliver(ev('event:membership-denied'))
  log.seal()
  const s = log.summary()
  t.ok(s.includes('event:state×2') && s.includes('event:membership-denied×1'))
  t.ok(s.includes('unconsumed boot backlog: event:state event:state event:membership-denied'))
})
