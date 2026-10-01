import test from 'brittle'
import { nextRunAt } from '../../src/shared/storage/backup/schedule-rules.js'

const at = (over = {}) => ({ firstDirtyAt: 0, lastEventAt: 0, urgency: 'normal', lastRunAt: null, now: 0, ...over })

test('nothing changed, nothing scheduled', (t) => {
  t.is(nextRunAt(at({ firstDirtyAt: null })), null)
})

test('an urgent change runs after 15 quiet seconds, at most a minute after the first', (t) => {
  t.is(nextRunAt(at({ urgency: 'urgent' })), 15_000)
  t.is(nextRunAt(at({ urgency: 'urgent', lastEventAt: 55_000, now: 55_000 })), 60_000)
})

test('an everyday change waits for three quiet minutes, at most an hour', (t) => {
  t.is(nextRunAt(at()), 180_000)
  t.is(nextRunAt(at({ lastEventAt: 3_590_000, now: 3_590_000 })), 3_600_000)
})

test('everyday runs are at least ten minutes apart; urgent ones are not held back', (t) => {
  t.is(nextRunAt(at({ lastRunAt: 0, firstDirtyAt: 1000, lastEventAt: 1000, now: 1000 })), 600_000)
  t.is(nextRunAt(at({ urgency: 'urgent', lastRunAt: 0, firstDirtyAt: 1000, lastEventAt: 1000, now: 1000 })), 16_000)
})

test('a time already passed means now', (t) => {
  t.is(nextRunAt(at({ now: 10_000_000 })), 10_000_000)
})
