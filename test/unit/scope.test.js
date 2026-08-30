import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import test from 'brittle'
import { Scope, scopeMatches } from '../../src/shared/contract/scope.js'

const here = path.dirname(fileURLToPath(import.meta.url))

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

// The two used to be hand-mirrored implementations that had to agree, and this matrix is what
// caught the divergences a hand-picked table missed. There is one implementation now, so comparing
// it to itself would be a tautology — instead the matrix pins its SEMANTICS against an independent
// reference written from the documented rule: a hint matches a view iff the kinds are equal and
// every id BOTH sides pin is equal. If the implementation is ever "simplified" into disagreeing
// with the rule it documents, this fails.
function referenceMatches (hint, view) {
  if (!hint || !view) return false
  if (hint.kind !== view.kind) return false
  for (const id of ['spaceId', 'shareId']) {
    if (view[id] != null && hint[id] != null && hint[id] !== view[id]) return false
  }
  return true
}

test('REGRESSION (FIX-EDA-13: the matcher agrees with its documented rule pairwise-exhaustively)', (t) => {
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
      if (view === null) continue
      if (scopeMatches(hint, view) !== referenceMatches(hint, view)) mismatches.push([hint, view])
    }
  }
  t.is(scopes.length, 97, 'the matrix is the size it claims')
  t.alike(mismatches, [], 'every (hint, view) pair decides as the documented rule says')
})

// The twin is gone: src/renderer/scope.ts re-exports the contract's implementation, so there is no
// second copy to disagree with. Asserted structurally, since a future re-introduction would be
// silent otherwise.
test('the renderer re-exports the contract rather than reimplementing it', (t) => {
  const src = readFileSync(path.join(here, '..', '..', 'src', 'renderer', 'scope.ts'), 'utf8')
  t.ok(/export \{ Scope, scopeMatches \} from '\.\.\/shared\/contract\/scope\.js'/.test(src),
    'scope.ts is an import path, not an implementation')
  t.absent(/function scopeMatches/.test(src), 'no second implementation crept back in')
})
