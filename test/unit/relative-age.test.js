import test from 'brittle'
import { relativeAge } from '../../src/renderer/model/relative-age.js'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

test('under a minute reads as now', (t) => {
  t.alike(relativeAge(0), { value: 0, unit: 'second' })
  t.alike(relativeAge(59 * 1000), { value: 0, unit: 'second' })
})

test('a time ahead of now reads as now, never as the future', (t) => {
  t.alike(relativeAge(-HOUR), { value: 0, unit: 'second' })
})

test('the age reads in the largest whole unit', (t) => {
  t.alike(relativeAge(5 * MINUTE), { value: 5, unit: 'minute' })
  t.alike(relativeAge(3 * HOUR), { value: 3, unit: 'hour' })
  t.alike(relativeAge(2 * DAY), { value: 2, unit: 'day' })
  t.alike(relativeAge(15 * DAY), { value: 2, unit: 'week' })
  t.alike(relativeAge(61 * DAY), { value: 2, unit: 'month' })
  t.alike(relativeAge(800 * DAY), { value: 2, unit: 'year' })
})

test('with days as the finest unit, a same-day age reads as today', (t) => {
  t.alike(relativeAge(3 * HOUR, { smallest: 'day' }), { value: 0, unit: 'day' })
  t.alike(relativeAge(DAY + 1000, { smallest: 'day' }), { value: 1, unit: 'day' })
})
