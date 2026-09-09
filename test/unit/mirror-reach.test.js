import test from 'brittle'
import { mirrorMayFetch } from '../../src/shared/folders/mirror-reach.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const ME = 'a'.repeat(64)
const THEM = 'b'.repeat(64)

test('a reachable owner may be fetched from; an unreachable one may not', (t) => {
  t.is(mirrorMayFetch({ ownerKey: THEM, localKey: ME, ownerOnline: true }), true)
  t.is(mirrorMayFetch({ ownerKey: THEM, localKey: ME, ownerOnline: false }), false,
    'the whole point of the change')
})

// REGRESSION (FIX-MIRROR-OFFLINE): presence leases track REMOTE peers only, so our own key is never
// online. A bare isOwnerOnline(ownerKey) gate would freeze every self-mirror permanently — and
// test/helpers/owned.js::setupSelfMirror, which most of the mirror integration suite is built on,
// mounts with exactly that ownerKey.
test('a self-mirror is always reachable, whatever presence says', (t) => {
  t.is(mirrorMayFetch({ ownerKey: ME, localKey: ME, ownerOnline: false }), true)
  t.is(mirrorMayFetch({ ownerKey: ME, localKey: ME, ownerOnline: true }), true)
})

// The fail-safe direction: unknown means MORE work, never less. A mirror that goes quiet on a
// missing field is a silent sync outage; a mirror that pays one wasted pass is a log line.
test('an unknown owner falls open, and a missing local key only disables the self shortcut', (t) => {
  t.is(mirrorMayFetch({ ownerKey: null, localKey: ME, ownerOnline: false }), true, 'no owner key')
  t.is(mirrorMayFetch({}), true, 'nothing known at all')
  t.is(mirrorMayFetch({ ownerKey: THEM, localKey: null, ownerOnline: false }), false,
    'a null local key does NOT make a remote owner reachable')
})

test('ownerOnline is coerced to a boolean, never leaked', (t) => {
  t.is(mirrorMayFetch({ ownerKey: THEM, localKey: ME, ownerOnline: undefined }), false)
  t.is(mirrorMayFetch({ ownerKey: THEM, localKey: ME, ownerOnline: 1 }), true)
})

// share-listing.js keeps its own `isOwn ? true : …` because it answers a different question (what to
// DISPLAY, not whether to FETCH). foreign-folders.js must not grow a second hand-rolled copy of THIS
// one: two copies of the self-mirror rule is how they drift, and the drift is silent.
test('foreign-folders routes every fetch-reachability decision through mirrorMayFetch', (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.join(here, '..', '..', 'src', 'shared', 'folders', 'foreign-folders.js'), 'utf8')
  const direct = src.match(/isOwnerOnline\(/g) || []
  // Exactly two: the deletion guard (shouldHonorDeletions) and mayFetch(). A third is a copy.
  t.is(direct.length, 2, 'isOwnerOnline is called exactly twice')
  t.ok(/function mayFetch\s*\(/.test(src), 'the single reachability helper exists')
  t.ok(/mirrorMayFetch\(/.test(src), 'and it delegates to the pure rule')
})
