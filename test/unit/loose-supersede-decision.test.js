import test from 'brittle'
import { supersedeDecision, isRepublished } from '../../src/shared/transfer/supersede-decision.js'

// REGRESSION (FIX-REMOVE-1: a remove+re-add — even of identical content, even one never
// observed as a tombstone — must terminate a download, not auto-resume). isRepublished is the
// pure gate the reconcile keys on: a bumped catalog seq means the source was re-written.
test('isRepublished: a changed seq is a re-publish; equal or unknown seqs are not', (t) => {
  t.ok(isRepublished(9, 5), 'a higher seq is a re-publish')
  t.ok(isRepublished(5, 9), 'any different seq is a re-publish')
  t.absent(isRepublished(5, 5), 'the same seq is not a re-publish')
  t.absent(isRepublished(undefined, 5), 'an unknown current seq (unread head) is never a re-publish')
  t.absent(isRepublished(5, undefined), 'an unknown source seq (legacy row) is never a re-publish')
  t.absent(isRepublished(undefined, undefined), 'both unknown is not a re-publish')
})

// REGRESSION (FIX-1: a mid-transfer source change must auto-restart on the new hash).
// supersedeDecision is the pure gate the catalog-append reconcile keys on.
test('supersedeDecision: a different non-null hash restarts', (t) => {
  t.is(supersedeDecision('aaa', 'bbb'), 'restart')
})

test('supersedeDecision: an unchanged hash is skipped', (t) => {
  t.is(supersedeDecision('aaa', 'aaa'), 'skip')
})

test('supersedeDecision: a null/undefined current hash (tombstone or mid-rehash) is skipped', (t) => {
  t.is(supersedeDecision('aaa', null), 'skip')
  t.is(supersedeDecision('aaa', undefined), 'skip')
  t.is(supersedeDecision('aaa', ''), 'skip')
})

test('supersedeDecision: no in-flight hash yet still restarts on a real new hash', (t) => {
  t.is(supersedeDecision(null, 'bbb'), 'restart')
})
