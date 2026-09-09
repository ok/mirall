import test from 'brittle'
import {
  PUBLISH_ORDERS as CONFIG_ORDERS, setRuntimeConfig, getRuntimeConfig, getPublishConcurrency, getPublishOrder,
  getPublishStallWindowMs, getReconcileStallWindowMs, getSupervisionRecoverBudgetMs, getConvergenceStallWindowMs,
} from '../../src/shared/core/runtime-config.js'
import { PUBLISH_ORDERS as ITEM_ORDERS, comparatorFor } from '../../src/shared/folders/work-item.js'

test('runtime-config and work-item agree on the valid publish orders', (t) => {
  t.alike(CONFIG_ORDERS, ITEM_ORDERS)
  for (const name of CONFIG_ORDERS) t.is(typeof comparatorFor(name), 'function', name + ' has a comparator')
})

test('publishOrder defaults to smallest-first and rejects unknown names', (t) => {
  const before = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(before))
  setRuntimeConfig({})
  t.is(getPublishOrder(), 'smallest-first')
  setRuntimeConfig({ publishOrder: 'largest-first' })
  t.is(getPublishOrder(), 'largest-first')
  setRuntimeConfig({ publishOrder: 'random' })
  t.is(getPublishOrder(), 'smallest-first', 'an unknown name falls back rather than wedging the queue')
})

test('publishConcurrency defaults to 2 and never resolves below 1', (t) => {
  const before = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(before))
  setRuntimeConfig({})
  t.is(getPublishConcurrency(), 2)
  setRuntimeConfig({ publishConcurrency: 3 })
  t.is(getPublishConcurrency(), 3)
  setRuntimeConfig({ publishConcurrency: 0 })
  t.is(getPublishConcurrency(), 2, '0 is not "unbounded" here — it would mean a lane that never pumps')
  setRuntimeConfig({ publishConcurrency: -4 })
  t.is(getPublishConcurrency(), 2)
  setRuntimeConfig({ publishConcurrency: Infinity })
  t.is(getPublishConcurrency(), Infinity, 'an explicit Infinity is honoured')
})

// REGRESSION (FIX-BUDGET-SENTINELS: the three supervision budgets were added to the DEFAULTED
// group, whose contract is that 0 and Infinity are meaningful overrides. For a deadline both
// invert: 0 makes stallVerdict condemn every pass the instant it starts — so the supervisor would
// evict every healthy publish and abandon every healthy scan — and Infinity reaches setTimeout,
// which clamps it to about a millisecond, turning "no timeout" into "instant timeout".)
test('REGRESSION (FIX-BUDGET-SENTINELS): a 0 or Infinity supervision budget falls back to the default', (t) => {
  const before = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(before))

  const getters = [
    ['publishStallWindowMs', getPublishStallWindowMs],
    ['reconcileStallWindowMs', getReconcileStallWindowMs],
    ['supervisionRecoverBudgetMs', getSupervisionRecoverBudgetMs],
    ['convergenceStallWindowMs', getConvergenceStallWindowMs],
  ]
  for (const [field, get] of getters) {
    setRuntimeConfig({ ...before })
    const fallback = get()
    t.ok(fallback > 0, `${field} has a positive default`)
    for (const bad of [0, Infinity, -1, NaN, null, 'soon']) {
      setRuntimeConfig({ ...before, [field]: bad })
      t.is(get(), fallback, `${field}: ${String(bad)} is not a budget`)
    }
    setRuntimeConfig({ ...before, [field]: 1234 })
    t.is(get(), 1234, `${field} still honours a real override`)
  }
})
