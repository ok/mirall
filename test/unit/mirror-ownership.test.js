import test from 'brittle'
import { classifyLocalCopy, mayOverwriteInPlace, LOCAL_COPY } from '../../src/shared/folders/mirror-ownership.js'

const OWNER = 'o'.repeat(64)
const OURS = 'a'.repeat(64)
const USER = 'u'.repeat(64)

test('the local copy is the owner current content', (t) => {
  const v = classifyLocalCopy({ diskHash: OWNER, ownerHash: OWNER, ancestorHash: OURS })
  t.is(v, LOCAL_COPY.OWNER_CURRENT)
  t.ok(mayOverwriteInPlace(v))
})

test('the local copy is exactly what we delivered, so the owner moved on', (t) => {
  const v = classifyLocalCopy({ diskHash: OURS, ownerHash: OWNER, ancestorHash: OURS })
  t.is(v, LOCAL_COPY.OURS)
  t.ok(mayOverwriteInPlace(v), 'an untouched mirror copy is ours to update in place')
})

test('REGRESSION (FIX-D2): a local copy that is neither is the user edit — never overwrite', (t) => {
  const v = classifyLocalCopy({ diskHash: USER, ownerHash: OWNER, ancestorHash: OURS })
  t.is(v, LOCAL_COPY.DIVERGED)
  t.absent(mayOverwriteInPlace(v), 'this is the overwrite that destroyed user edits')
})

test('no ancestor on record proves nothing, so it fails closed', (t) => {
  const v = classifyLocalCopy({ diskHash: USER, ownerHash: OWNER, ancestorHash: null })
  t.is(v, LOCAL_COPY.UNKNOWN)
  t.absent(mayOverwriteInPlace(v), 'absence of evidence is not evidence of ownership')
})

test('an unreadable local file is never overwritten', (t) => {
  const v = classifyLocalCopy({ diskHash: null, ownerHash: OWNER, ancestorHash: OURS })
  t.is(v, LOCAL_COPY.UNKNOWN)
  t.absent(mayOverwriteInPlace(v))
})

test('owner-current outranks ours when all three agree', (t) => {
  t.is(classifyLocalCopy({ diskHash: OWNER, ownerHash: OWNER, ancestorHash: OWNER }), LOCAL_COPY.OWNER_CURRENT)
})

test('an empty call does not throw and does not authorize an overwrite', (t) => {
  t.is(classifyLocalCopy(), LOCAL_COPY.UNKNOWN)
  t.absent(mayOverwriteInPlace(classifyLocalCopy()))
})
