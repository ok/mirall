import test from 'brittle'
import { PUBLISH_ORDERS as CONFIG_ORDERS, setRuntimeConfig, getRuntimeConfig, getPublishConcurrency, getPublishOrder } from '../../src/shared/core/runtime-config.js'
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
