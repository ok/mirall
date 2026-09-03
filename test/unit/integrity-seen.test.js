import test from 'brittle'
import { createIntegritySeen, DEFAULT_INTEGRITY_ROW_CAP } from '../../src/shared/folders/integrity-seen.js'

const M = 'space1|folder1'

test('the first claim is admitted and every repeat is refused', (t) => {
  const seen = createIntegritySeen()
  t.ok(seen.admit(M, 'a/doc.pdf', 'h1'), 'the first mismatch is a new fact')
  t.absent(seen.admit(M, 'a/doc.pdf', 'h1'), 'the next 30s tick is the same fact')
  t.absent(seen.admit(M, 'a/doc.pdf', 'h1'))
  t.is(seen.size(M), 1)
})

test('a re-publish under a new hash is a NEW claim', (t) => {
  const seen = createIntegritySeen()
  t.ok(seen.admit(M, 'a/doc.pdf', 'h1'))
  t.ok(seen.admit(M, 'a/doc.pdf', 'h2'), 'different bytes were advertised and they failed too')
  t.is(seen.size(M), 2)
})

test('two files on one mount are two claims', (t) => {
  const seen = createIntegritySeen()
  t.ok(seen.admit(M, 'one.bin', 'h1'))
  t.ok(seen.admit(M, 'two.bin', 'h1'))
})

test('two mounts do not share a memo', (t) => {
  const seen = createIntegritySeen()
  t.ok(seen.admit(M, 'doc.pdf', 'h1'))
  t.ok(seen.admit('space1|folder2', 'doc.pdf', 'h1'), 'same file, different mount, different claim')
})

test('forget re-arms one mount and leaves the others alone', (t) => {
  const seen = createIntegritySeen()
  seen.admit(M, 'doc.pdf', 'h1')
  seen.admit('space1|folder2', 'doc.pdf', 'h1')
  seen.forget(M)
  t.ok(seen.admit(M, 'doc.pdf', 'h1'), 'a remount is a fresh session')
  t.absent(seen.admit('space1|folder2', 'doc.pdf', 'h1'), 'the sibling mount kept its memo')
})

test('clear re-arms everything', (t) => {
  const seen = createIntegritySeen()
  seen.admit(M, 'doc.pdf', 'h1')
  seen.clear()
  t.ok(seen.admit(M, 'doc.pdf', 'h1'))
})

test('a missing hash still forms a usable claim', (t) => {
  const seen = createIntegritySeen()
  t.ok(seen.admit(M, 'doc.pdf', null))
  t.absent(seen.admit(M, 'doc.pdf', null))
})

test('the per-mount cap bounds the memo and announces itself exactly once', (t) => {
  const capped = []
  const seen = createIntegritySeen({ limit: 3, onCap: (key, n) => capped.push([key, n]) })
  t.ok(seen.admit(M, 'f1', 'h'))
  t.ok(seen.admit(M, 'f2', 'h'))
  t.ok(seen.admit(M, 'f3', 'h'))
  t.absent(seen.admit(M, 'f4', 'h'), 'past the cap nothing is admitted')
  t.absent(seen.admit(M, 'f5', 'h'))
  t.is(seen.size(M), 3, 'a 150k-file mirror cannot grow the memo without bound')
  t.alike(capped, [[M, 3]], 'announced once, not on every later refusal')
})

test('one mount hitting its cap does not silence another', (t) => {
  const seen = createIntegritySeen({ limit: 1 })
  t.ok(seen.admit(M, 'f1', 'h'))
  t.absent(seen.admit(M, 'f2', 'h'))
  t.ok(seen.admit('space1|folder2', 'f2', 'h'))
})

test('the shipped default cap is a positive integer', (t) => {
  t.ok(Number.isInteger(DEFAULT_INTEGRITY_ROW_CAP) && DEFAULT_INTEGRITY_ROW_CAP > 0)
})
