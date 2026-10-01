import test from 'brittle'
import b4a from 'b4a'
import { newRepoKey, wrapRepoKey, unwrapRepoKey, repoSubkeys, objectId, sealBlob, openBlob } from '../../src/shared/storage/backup/repo-crypto.js'

const key = () => newRepoKey()

test('a blob opens only with its key and associated data', (t) => {
  const k = key()
  const sealed = sealBlob(k, b4a.from('hello'), 'ad-1')
  t.alike(openBlob(k, sealed, 'ad-1'), b4a.from('hello'))
  t.is(openBlob(key(), sealed, 'ad-1'), null, 'another key')
  t.is(openBlob(k, sealed, 'ad-2'), null, 'another name')
  const flipped = b4a.from(sealed)
  flipped[flipped.byteLength - 1] ^= 1
  t.is(openBlob(k, flipped, 'ad-1'), null, 'a changed byte')
  t.is(openBlob(k, b4a.from('not a blob at all'), 'ad-1'), null)
})

test('sealed sizes come in 4 KiB steps, so a target sees buckets, not lengths', (t) => {
  const k = key()
  const header = 4 + 1 + 24 + 16
  t.is(sealBlob(k, b4a.alloc(10), 'x').byteLength - header, 4096)
  t.is(sealBlob(k, b4a.alloc(4092), 'x').byteLength - header, 4096)
  t.is(sealBlob(k, b4a.alloc(4093), 'x').byteLength - header, 8192)
  t.alike(openBlob(k, sealBlob(k, b4a.alloc(0), 'x'), 'x'), b4a.alloc(0), 'an empty blob round-trips')
})

test('object ids are stable for one repository and differ between repositories', (t) => {
  const keys = repoSubkeys(key())
  const plain = b4a.from('same bytes')
  t.is(objectId(keys, plain), objectId(keys, plain))
  t.not(objectId(keys, plain), objectId(repoSubkeys(key()), plain))
  t.is(objectId(keys, plain).length, 64)
})

test('the subkeys are distinct', (t) => {
  const { id, object, snapshot } = repoSubkeys(key())
  t.not(b4a.toString(id, 'hex'), b4a.toString(object, 'hex'))
  t.not(b4a.toString(object, 'hex'), b4a.toString(snapshot, 'hex'))
})

test('the repository key unwraps only with its wrap key and repository id', (t) => {
  const repoKey = key()
  const wrapKey = key()
  const wrap = wrapRepoKey(repoKey, wrapKey, 'repo-a')
  t.alike(unwrapRepoKey(wrap, wrapKey, 'repo-a'), repoKey)
  t.is(unwrapRepoKey(wrap, key(), 'repo-a'), null, 'another identity')
  t.is(unwrapRepoKey(wrap, wrapKey, 'repo-b'), null, 'a header copied into another repository')
  t.is(unwrapRepoKey(null, wrapKey, 'repo-a'), null)
})
