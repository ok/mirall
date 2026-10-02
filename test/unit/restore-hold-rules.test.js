import test from 'brittle'
import { releaseVerdict } from '../../src/shared/core/restore-hold-rules.js'
import { RESTORE_VERDICT } from '../../src/shared/contract/restore-verdict.js'

const state = (over = {}) => ({ localLength: 10, contiguousLength: 10, holderLengths: [10], firstHolderAt: 0, now: 30_000, dwellMs: 20_000, coMembers: 1, ...over })

test('a core no connected peer holds stays held', (t) => {
  t.is(releaseVerdict(state({ holderLengths: [], firstHolderAt: null })), RESTORE_VERDICT.NO_HOLDER)
  t.is(releaseVerdict(state({ localLength: 0, contiguousLength: 0, holderLengths: [], firstHolderAt: null })), RESTORE_VERDICT.NO_HOLDER,
    'an empty core with nobody to ask is never released as solo')
})

test('a holder with a longer copy keeps the core held', (t) => {
  t.is(releaseVerdict(state({ localLength: 4, contiguousLength: 4 })), RESTORE_VERDICT.BEHIND)
})

test('the longest holder decides, not the first', (t) => {
  t.is(releaseVerdict(state({ holderLengths: [10, 12] })), RESTORE_VERDICT.BEHIND)
  t.is(releaseVerdict(state({ localLength: 12, contiguousLength: 12, holderLengths: [10, 12] })), RESTORE_VERDICT.CAUGHT_UP)
})

test('a matched length with blocks still missing is not caught up', (t) => {
  t.is(releaseVerdict(state({ contiguousLength: 7 })), RESTORE_VERDICT.DOWNLOADING)
})

test('a caught-up core waits out the dwell after the first holder answered', (t) => {
  t.is(releaseVerdict(state({ now: 19_999 })), RESTORE_VERDICT.DWELL)
  t.is(releaseVerdict(state({ now: 20_000 })), RESTORE_VERDICT.CAUGHT_UP, 'the boundary releases')
})

test('a profile with data and no co-member anywhere has no other holder', (t) => {
  t.is(releaseVerdict(state({ holderLengths: [], firstHolderAt: null, coMembers: 0 })), RESTORE_VERDICT.CAUGHT_UP)
  t.is(releaseVerdict(state({ localLength: 0, contiguousLength: 0, holderLengths: [], firstHolderAt: null, coMembers: 0 })), RESTORE_VERDICT.NO_HOLDER,
    'an empty profile knows no roster, so its co-members are unknown, not absent')
})

test('a local copy longer than every holder is caught up', (t) => {
  t.is(releaseVerdict(state({ localLength: 11, contiguousLength: 11 })), RESTORE_VERDICT.CAUGHT_UP)
})

// REGRESSION (FIX-EMPTY-CATALOG-HELD: a space's empty own catalog stayed held for good after a
// backup restore once its last co-member left — "local data" was required to go solo).
test('an empty catalog in a space with nobody else is released', (t) => {
  t.is(releaseVerdict(state({ localLength: 0, contiguousLength: 0, holderLengths: [], firstHolderAt: null, coMembers: 0, emptyMayBeSolo: true })), RESTORE_VERDICT.CAUGHT_UP)
  t.is(releaseVerdict(state({ localLength: 0, contiguousLength: 0, holderLengths: [], firstHolderAt: null, coMembers: 0 })), RESTORE_VERDICT.NO_HOLDER, 'a profile restored from a key alone still waits')
})
