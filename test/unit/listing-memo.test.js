import test from 'brittle'
import { takeListingMemo, beginListingRead, settleListingRead, retainListingMemo, forgetListingMemo, resetListingMemo } from '../../src/shared/transfer/listing-memo.js'
import { DEFAULT_FULL_WALK_EVERY } from '../../src/shared/folders/mirror-policy.js'
import { getListFullReadEvery, getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const EVERY = { fullReadEvery: 10 }
const read = (entries, version, complete = true) => ({ entries, version, complete })

test('a catalog never read is read', (t) => {
  resetListingMemo()
  t.alike(takeListingMemo('s', 'k', 7, EVERY), { entries: null, reason: 'no-watermark' })
})

test('a complete read is served back while its version holds', (t) => {
  resetListingMemo()
  const entries = [{ relPath: 'a' }]
  beginListingRead('s', 'k', 'no-watermark')
  t.is(settleListingRead('s', 'k', read(entries, 7)), entries, 'the listing shows what it read')
  t.is(takeListingMemo('s', 'k', 7, EVERY).entries, entries, 'the same entries, no copy')
  t.is(takeListingMemo('s', 'k', 8, EVERY).reason, 'catalog-appended', 'a moved head is read')
  t.is(takeListingMemo('s', 'k', null, EVERY).reason, 'version-unknown', 'an unknown live version is read')
})

test('a read in flight leaves nothing to skip on', (t) => {
  resetListingMemo()
  settleListingRead('s', 'k', read([], 3))
  beginListingRead('s', 'k', 'catalog-appended')
  t.is(takeListingMemo('s', 'k', 3, EVERY).reason, 'no-watermark', 'a read that never settles cannot authorise a skip')
})

test('an incomplete or versionless read is never memoised', (t) => {
  resetListingMemo()
  const partial = [{ relPath: 'x' }]
  t.is(settleListingRead('s', 'k', read(partial, 3, false)), partial, 'the listing still shows what it could read')
  t.is(takeListingMemo('s', 'k', 3, EVERY).reason, 'no-watermark', 'incomplete')
  settleListingRead('s', 'k', read([{ relPath: 'x' }], null))
  t.is(takeListingMemo('s', 'k', 3, EVERY).reason, 'no-watermark', 'no version')
})

test('the backstop reads on the Nth consult and a fresh read restarts the count', (t) => {
  resetListingMemo()
  settleListingRead('s', 'k', read([], 1))
  for (let i = 0; i < 9; i++) t.ok(takeListingMemo('s', 'k', 1, EVERY).entries, `skip ${i + 1}`)
  t.is(takeListingMemo('s', 'k', 1, EVERY).reason, 'backstop')
  settleListingRead('s', 'k', read([], 1))
  t.ok(takeListingMemo('s', 'k', 1, EVERY).entries, 'skipping again after the re-read')
  t.is(takeListingMemo('s', 'k', 1, { fullReadEvery: 1 }).reason, 'backstop-disabled')
})

test('memos are per space and per catalog; forget drops one space, reset every space', (t) => {
  resetListingMemo()
  settleListingRead('s1', 'k', read([], 1))
  settleListingRead('s1', 'k2', read([], 1))
  settleListingRead('s2', 'k', read([], 1))
  beginListingRead('s1', 'k2', 'catalog-appended')
  t.ok(takeListingMemo('s1', 'k', 1, EVERY).entries, 'a sibling catalog is untouched by a read')
  forgetListingMemo('s1')
  t.is(takeListingMemo('s1', 'k', 1, EVERY).reason, 'no-watermark')
  t.ok(takeListingMemo('s2', 'k', 1, EVERY).entries, 'another space keeps its memo')
  resetListingMemo()
  t.is(takeListingMemo('s2', 'k', 1, EVERY).reason, 'no-watermark')
})

// A backstop read is the only read with nothing saying the catalog moved; one that cannot finish
// learns nothing, so the entries it would have replaced stand. Any other reason means they are stale.
test('a backstop read that cannot finish keeps the prior entries; any other read drops them', (t) => {
  resetListingMemo()
  const whole = [{ relPath: 'a' }, { relPath: 'b' }]
  settleListingRead('s', 'k', read(whole, 4))
  for (let i = 0; i < 9; i++) takeListingMemo('s', 'k', 4, EVERY)
  const { reason } = takeListingMemo('s', 'k', 4, EVERY)
  t.is(reason, 'backstop')
  const prior = beginListingRead('s', 'k', reason)
  t.is(settleListingRead('s', 'k', read([{ relPath: 'a' }], null, false), prior), whole, 'a stalled drain shows the kept entries')
  t.is(takeListingMemo('s', 'k', 4, EVERY).entries, whole, 'and they are served again, the count restarted')
  t.alike(settleListingRead('s', 'k', null, beginListingRead('s', 'k', 'backstop')), whole, 'a backstop read that threw keeps them too')

  t.is(beginListingRead('s', 'k', 'catalog-appended'), null, 'a moved catalog hands back nothing to keep')
  t.alike(settleListingRead('s', 'k', null, null), [], 'so a throw shows no rows')
  t.is(takeListingMemo('s', 'k', 4, EVERY).reason, 'no-watermark')
})

test('retain drops the catalogs of members no longer listed', (t) => {
  resetListingMemo()
  settleListingRead('s', 'gone', read([], 1))
  settleListingRead('s', 'kept', read([], 1))
  retainListingMemo('s', new Set(['kept']))
  t.is(takeListingMemo('s', 'gone', 1, EVERY).reason, 'no-watermark')
  t.ok(takeListingMemo('s', 'kept', 1, EVERY).entries)
})

// Declared twice across a layer boundary, like the mirror's backstop: pin their agreement.
test('listFullReadEvery defaults to the mirror backstop', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))
  setRuntimeConfig({})
  t.is(getListFullReadEvery(), DEFAULT_FULL_WALK_EVERY)
})
