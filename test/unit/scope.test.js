import test from 'brittle'
import { Scope, scopeMatches } from '../../src/shared/state/scope.js'
import { scopeMatches as rendererScopeMatches } from '../../src/renderer/scope-match.js'

test('scopeMatches: kind + space must agree', (t) => {
  t.ok(scopeMatches(Scope.files('S1'), Scope.files('S1')))
  t.absent(scopeMatches(Scope.files('S1'), Scope.files('S2')), 'different space does not match')
  t.absent(scopeMatches(Scope.files('S1'), Scope.members('S1')), 'different kind does not match')
})

test('scopeMatches: share-files compares shareId; a space-wide hint matches any share', (t) => {
  t.ok(scopeMatches(Scope.shareFiles('S1', 'A'), Scope.shareFiles('S1', 'A')))
  t.absent(scopeMatches(Scope.shareFiles('S1', 'A'), Scope.shareFiles('S1', 'B')))
  t.ok(scopeMatches({ kind: 'share-files', spaceId: 'S1' }, Scope.shareFiles('S1', 'A')),
    'a hint without a shareId is space-wide and matches any share view')
})

test('scopeMatches: guards null/undefined inputs', (t) => {
  t.absent(scopeMatches(null, Scope.files('S1')))
  t.absent(scopeMatches(Scope.files('S1'), null))
})

test('scopeMatches: a spaceId-less members view (the spaces list) matches any members hint', (t) => {
  t.ok(scopeMatches(Scope.members('S1'), { kind: 'members' }))
  t.ok(scopeMatches(Scope.members('S2'), { kind: 'members' }))
  t.absent(scopeMatches(Scope.files('S1'), { kind: 'members' }))
})

// scope.js (worker) and scope-match.js (renderer) are hand-mirrored; a reconcile emitted with
// one and consumed by the other must decide identically. A hand-picked matrix missed two
// executed divergence classes (a narrow share-files hint vs a broad view, and shareIds on a
// non-share-files kind), so this asserts agreement pairwise-exhaustively instead.
test('REGRESSION (FIX-EDA-13: renderer mirror agrees with the worker pairwise-exhaustively)', (t) => {
  const kinds = ['files', 'shares', 'share-files', 'members', 'mirrors', 'join-requests']
  const spaceIds = ['S1', 'S2', null, undefined]
  const shareIds = ['A', 'B', null, undefined]
  const scopes = [null]
  for (const kind of kinds) {
    for (const spaceId of spaceIds) {
      for (const shareId of shareIds) {
        const s = { kind }
        if (spaceId !== undefined) s.spaceId = spaceId
        if (shareId !== undefined) s.shareId = shareId
        scopes.push(s)
      }
    }
  }
  const mismatches = []
  for (const hint of scopes) {
    for (const view of scopes) {
      if (rendererScopeMatches(hint, view) !== scopeMatches(hint, view)) mismatches.push([hint, view])
    }
  }
  t.alike(mismatches, [], 'every (hint, view) pair decides identically in both matchers')
})
