import test from 'brittle'
import { createSupervisionPolicy, DEFAULT_POLICY } from '../../src/shared/core/supervision.js'

const row = (key, ok, name = 'mirrors') => ({ id: name + ' ' + key, name, key, ok, detail: ok ? null : 'stuck' })
const actions = (out) => out.map((d) => d.action)

test('a healthy unit is never acted on', (t) => {
  const policy = createSupervisionPolicy()
  t.alike(actions(policy.evaluate([row('a', true)])), [])
  t.alike(actions(policy.evaluate([row('a', true)])), [])
})

test('a recovery needs consecutiveBad probes, not one', (t) => {
  const policy = createSupervisionPolicy()
  t.alike(actions(policy.evaluate([row('a', false)])), ['note'], 'one bad probe only notes it')
  t.alike(actions(policy.evaluate([row('a', false)])), ['recover'])
})

test('one healthy probe resets the streak', (t) => {
  const policy = createSupervisionPolicy()
  policy.evaluate([row('a', false)])
  policy.evaluate([row('a', true)])
  t.alike(actions(policy.evaluate([row('a', false)])), ['note'], 'the streak restarted from zero')
})

test('a recovery clears the streak, so the next one costs a full window again', (t) => {
  const policy = createSupervisionPolicy()
  policy.evaluate([row('a', false)])
  t.alike(actions(policy.evaluate([row('a', false)])), ['recover'])
  t.alike(actions(policy.evaluate([row('a', false)])), ['note'], 'not a second recovery on the very next probe')
})

test('the budget is enforced and the give-up is reported exactly once', (t) => {
  const policy = createSupervisionPolicy()
  for (let i = 0; i < DEFAULT_POLICY.maxRecoveries; i++) {
    policy.evaluate([row('a', false)])
    t.alike(actions(policy.evaluate([row('a', false)])), ['recover'], 'recovery ' + (i + 1))
  }
  policy.evaluate([row('a', false)])
  t.alike(actions(policy.evaluate([row('a', false)])), ['gave-up'], 'the budget is spent')
  t.alike(actions(policy.evaluate([row('a', false)])), [], 'and it is not restated every probe')
  t.is(policy.stats().recoveries['mirrors a'], DEFAULT_POLICY.maxRecoveries)
})

test('a unit that disappears drops its counters', (t) => {
  const policy = createSupervisionPolicy()
  policy.evaluate([row('a', false)])
  policy.evaluate([row('a', false)])
  t.is(policy.stats().recoveries['mirrors a'], 1)

  policy.evaluate([])
  t.alike(policy.stats().recoveries, {}, 'an unmounted unit leaves no spent budget behind')
  t.alike(actions(policy.evaluate([row('a', false)])), ['note'], 'and a key reused later starts fresh')
})

test('a per-subsystem override replaces the defaults for that subsystem only', (t) => {
  const policy = createSupervisionPolicy({ mirrors: { consecutiveBad: 1, maxRecoveries: 1 } })
  const both = () => [row('a', false), row('b', false, 'views')]
  t.alike(actions(policy.evaluate(both())), ['recover', 'note'], 'one bad probe is enough for mirrors, not for views')
  t.alike(actions(policy.evaluate(both())), ['gave-up', 'recover'], 'the override budget is one; views still has three')
})

test('two subsystems using the same unit key are counted separately', (t) => {
  const policy = createSupervisionPolicy()
  const rows = [row('shared', false, 'mirrors'), row('shared', false, 'views')]
  t.alike(actions(policy.evaluate(rows)), ['note', 'note'])
  t.alike(actions(policy.evaluate(rows)), ['recover', 'recover'], 'neither pooled the other\'s strikes')
})

test('one unhealthy unit does not disturb a healthy sibling', (t) => {
  const policy = createSupervisionPolicy()
  policy.evaluate([row('a', false), row('b', true)])
  const out = policy.evaluate([row('a', false), row('b', true)])
  t.alike(out.map((d) => d.row.key), ['a'])
})
