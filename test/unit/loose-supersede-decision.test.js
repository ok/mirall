import test from 'brittle'
import { supersedeDecision, isRepublished, republishDecision } from '../../src/shared/transfer/supersede-decision.js'

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

// REGRESSION (FIX-3: a re-publish is TWO appends — advertise(contentHash:null) → hash the source
// → setMaterializedHash. The old reconcile read the null-hash window as a remove+re-add of
// identical content and DROPPED the download, which then never resumed. republishDecision names
// that third state ('pending') instead of collapsing it into 'drop'.
const S1 = 5
const S2 = 6

test('republishDecision: the mid-rehash null-hash window is PENDING, not a drop', (t) => {
  t.is(republishDecision('h1', { removed: false, seq: S2, contentHash: null }, S1), 'pending',
    'a re-published entry whose hash has not materialized yet holds the transfer')
})

test('republishDecision: a tombstoned entry drops', (t) => {
  t.is(republishDecision('h1', { removed: true }, S1), 'drop')
})

test('republishDecision: a re-add of identical content drops (no silent partial resume)', (t) => {
  t.is(republishDecision('h1', { removed: false, seq: S2, contentHash: 'h1' }, S1), 'drop')
})

test('republishDecision: a re-publish with different materialized content restarts', (t) => {
  t.is(republishDecision('h1', { removed: false, seq: S2, contentHash: 'h2' }, S1), 'restart')
})

test('republishDecision: no re-publish (same seq) continues', (t) => {
  t.is(republishDecision('h1', { removed: false, seq: S1, contentHash: 'h1' }, S1), 'continue')
})

test('republishDecision: unknown seqs (legacy row / unread head) continue — never a re-publish', (t) => {
  t.is(republishDecision('h1', { removed: false, seq: undefined, contentHash: 'h2' }, undefined), 'continue')
  t.is(republishDecision('h1', { removed: false, seq: S2, contentHash: 'h2' }, undefined), 'continue')
})

test('republishDecision: a missing state (unreadable head) continues — never destructive', (t) => {
  t.is(republishDecision('h1', null, S1), 'continue')
  t.is(republishDecision('h1', undefined, S1), 'continue')
})

test('republishDecision: an inactive row with no recorded hash still holds the null window', (t) => {
  // Rows written before the contentHash field existed: the mid-rehash window must STILL be
  // 'pending' (the null hash decides it), never a drop.
  t.is(republishDecision(undefined, { removed: false, seq: S2, contentHash: null }, S1), 'pending')
})

test('republishDecision: without a recorded hash, a materialized re-publish drops (FIX-REMOVE-1 holds)', (t) => {
  // We cannot prove the content changed, so the remove+re-add rule wins over an eager restart.
  t.is(republishDecision(undefined, { removed: false, seq: S2, contentHash: 'h2' }, S1), 'drop')
  t.is(republishDecision(null, { removed: false, seq: S2, contentHash: 'h2' }, S1), 'drop')
})
