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

const observed = (key, ok) => ({ ...row(key, ok, 'owned-folders'), recoverable: false })

test('an observe-only unit is noted, never recovered, and never given up on', (t) => {
  const policy = createSupervisionPolicy()
  const seen = []
  for (let i = 0; i < 40; i++) seen.push(policy.evaluate([observed('u1', false)])[0]?.action ?? null)

  t.absent(seen.includes('recover'), 'no recovery is ever proposed')
  t.absent(seen.includes('gave-up'), 'there is nothing to give up on')
  t.is(seen[0], 'note', 'the first bad probe is still under the consecutive-bad threshold')
  t.is(seen[1], 'observe', 'it is stated once the threshold is crossed')
  t.is(seen.filter((a) => a === 'observe').length, 4, 'and restated on the backoff, not every probe')
  t.alike(policy.stats().recoveries, {}, 'no budget was spent')
})

test('an observe-only unit that heals clears its streak', (t) => {
  const policy = createSupervisionPolicy()
  policy.evaluate([observed('u1', false)])
  policy.evaluate([observed('u1', false)])
  policy.evaluate([observed('u1', true)])
  t.alike(policy.stats().unhealthy, {}, 'the counter is cleared, not carried')
  t.is(policy.evaluate([observed('u1', false)])[0].action, 'note', 'and the next stall starts a fresh streak')
})

test('recoverable defaults to true — an existing client is unaffected', (t) => {
  const policy = createSupervisionPolicy()
  policy.evaluate([row('m1', false)])
  t.is(policy.evaluate([row('m1', false)])[0].action, 'recover')
})

test('an observe-only unit still counts as unhealthy in the stats', (t) => {
  const policy = createSupervisionPolicy()
  policy.evaluate([observed('u1', false)])
  policy.evaluate([observed('u1', false)])
  t.is(policy.stats().unhealthy['owned-folders u1'], 2, 'so the shareable bundle carries the count')
})

// The invariant both new recoveries depend on, stated once here: the budget lives on the ROW.
test('a unit that keeps being reported spends its budget and is finally given up on', (t) => {
  const policy = createSupervisionPolicy()
  const seen = []
  for (let i = 0; i < 20; i++) seen.push(policy.evaluate([row('u1', false)])[0]?.action ?? null)
  t.is(seen.filter((a) => a === 'recover').length, DEFAULT_POLICY.maxRecoveries, 'exactly maxRecoveries attempts')
  t.is(seen.filter((a) => a === 'gave-up').length, 1, 'then it is stated once and left down')
})

test('a unit that stops being reported loses its budget — which is why a recovery must not hide it', (t) => {
  const policy = createSupervisionPolicy()
  policy.evaluate([row('u1', false)])
  policy.evaluate([row('u1', false)])
  t.is(policy.stats().recoveries['mirrors u1'], 1, 'one recovery spent')

  policy.evaluate([])
  t.alike(policy.stats().recoveries, {}, 'the counters are pruned with the row')
  policy.evaluate([row('u1', false)])
  policy.evaluate([row('u1', false)])
  t.is(policy.stats().recoveries['mirrors u1'], 1, 'so the same unit starts over from a fresh budget')
})
