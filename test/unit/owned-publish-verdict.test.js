import test from 'brittle'
import { publishVerdict, ownedKey, SCAN_SETTLE_MS } from '../../src/shared/folders/owned-policy.js'

const file = (size, mtime) => ({ size, mtime })
const known = (size, mtime, contentHash = 'h') => ({ size, mtime, contentHash })

test('a file the catalog has never seen publishes', (t) => {
  t.is(publishVerdict(null, file(10, 1000)), 'publish')
  t.is(publishVerdict(undefined, file(0, 0)), 'publish', 'an empty file is still a file')
})

test('matching size and mtime with a hash behind them is unchanged', (t) => {
  t.is(publishVerdict(known(10, 1000), file(10, 1000)), 'unchanged')
  t.is(publishVerdict(known(11, 1000), file(10, 1000)), 'publish', 'a changed size publishes')
  t.is(publishVerdict(known(10, 1001), file(10, 1000)), 'publish', 'a changed mtime publishes')
})

// The catalog entry exists but carries no hash: the previous pass enqueued it and never settled,
// so there is nothing to compare against and the file has to go round again.
test('a catalog entry with no content hash is not evidence of a publish', (t) => {
  t.is(publishVerdict({ size: 10, mtime: 1000, contentHash: null }, file(10, 1000)), 'publish')
  t.is(publishVerdict({ size: 10, mtime: 1000 }, file(10, 1000)), 'publish')
})

// A relocated tree has fresh mtimes everywhere, so the deep pass distrusts them and lets the
// publish settle equality by hash instead.
test('a deep pass publishes everything, whatever the catalog says', (t) => {
  t.is(publishVerdict(known(10, 1000), file(10, 1000), { deep: true }), 'publish')
  t.is(publishVerdict(null, file(10, 1000), { deep: true, deferFresh: true }), 'publish',
    'and deep outranks deferFresh — an authoritative pass publishes what it sees')
})

test('a catch-up pass defers a file still inside the settle window', (t) => {
  const now = 100_000
  const fresh = file(10, now - 500)
  t.is(publishVerdict(null, fresh, { deferFresh: true, now }), 'defer')
  t.is(publishVerdict(null, fresh, { now }), 'publish', 'only a catch-up pass defers')
  t.is(publishVerdict(known(10, now - 500), fresh, { deferFresh: true, now }), 'unchanged',
    'a file the catalog already holds is never deferred')
})

test('the settle window is bounded at both ends', (t) => {
  const now = 100_000
  const at = (mtime) => publishVerdict(null, file(10, mtime), { deferFresh: true, now, settleMs: 2000 })
  t.is(at(now), 'defer', 'a file written this instant is still settling')
  t.is(at(now - 1999), 'defer')
  t.is(at(now - 2000), 'publish', 'the window is exclusive at its far edge')
  t.is(at(now - 60_000), 'publish')
})

// A future mtime — a clock-skewed network mount, a bad archive — gives a negative age, which is
// below the settle window on every run. Without the lower bound the catch-up pass would defer
// such a file forever, and nothing else publishes it until the periodic pass hours later.
test('a future mtime publishes rather than deferring forever', (t) => {
  const now = 100_000
  t.is(publishVerdict(null, file(10, now + 1), { deferFresh: true, now }), 'publish')
  t.is(publishVerdict(null, file(10, now + 86_400_000), { deferFresh: true, now }), 'publish')
})

test('the settle window defaults to the shared constant', (t) => {
  const now = 100_000
  t.is(SCAN_SETTLE_MS, 2000)
  t.is(publishVerdict(null, file(10, now - (SCAN_SETTLE_MS - 1)), { deferFresh: true, now }), 'defer')
  t.is(publishVerdict(null, file(10, now - SCAN_SETTLE_MS), { deferFresh: true, now }), 'publish')
})

// The separator is only safe because both ids are hex. Pinned so that the day one of them gains a
// colon, this says so here rather than two shares silently sharing a pass.
test('ownedKey pairs a space with a share, and relies on neither containing a colon', (t) => {
  t.is(ownedKey('sp', 'sh'), 'sp:sh')
  t.is(ownedKey('a', 'b:c'), ownedKey('a:b', 'c'), 'an id carrying the separator collides')
})
