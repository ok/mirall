import test from 'brittle'
import { facepileSlice, summarizeMembers, peerFaces, peerStackAvatar, PEER_STACK_MAX } from '../../src/renderer/model/member-summary.js'

const m = (k) => ({ publicKey: k, displayName: k })

test('summarizeMembers: empty list', (t) => {
  const s = summarizeMembers([])
  t.is(s.total, 0); t.alike(s.stack, []); t.is(s.overflow, 0)
})

test('summarizeMembers: all fit in the stack, no overflow', (t) => {
  const s = summarizeMembers([m('a'), m('b')], { stackMax: 8 })
  t.is(s.total, 2); t.is(s.stack.length, 2); t.is(s.overflow, 0)
})

test('summarizeMembers: caps the stack and counts the overflow', (t) => {
  const members = Array.from({ length: 11 }, (_, i) => m('m' + i))
  const s = summarizeMembers(members, { stackMax: 8 })
  t.is(s.stack.length, 8); t.is(s.overflow, 3); t.is(s.stack[0].publicKey, 'm0')
})

test('summarizeMembers: defaults stackMax to 8', (t) => {
  const members = Array.from({ length: 10 }, (_, i) => m('m' + i))
  const s = summarizeMembers(members)
  t.is(s.stack.length, 8); t.is(s.overflow, 2)
})

test('summarizeMembers: guards non-array input', (t) => {
  const s = summarizeMembers(undefined)
  t.is(s.total, 0); t.alike(s.stack, []); t.is(s.overflow, 0)
})

// REGRESSION (FIX-PLUSONE: a +1 chip hides a face behind a disc of exactly its own size).
test('facepileSlice: a lone overflow is absorbed — the chip starts at +2', (t) => {
  const four = Array.from({ length: 4 }, (_, i) => m('m' + i))
  const s = facepileSlice(four, 3)
  t.is(s.stack.length, 4, 'the fourth face is shown rather than counted')
  t.is(s.overflow, 0, 'so there is no chip at all')
})

test('facepileSlice: two over the cap still counts, from +2', (t) => {
  const five = Array.from({ length: 5 }, (_, i) => m('m' + i))
  const s = facepileSlice(five, 3)
  t.is(s.stack.length, 3, 'the cap holds once the chip earns its disc')
  t.is(s.overflow, 2)
})

test('facepileSlice: exactly the cap needs no chip', (t) => {
  const s = facepileSlice([m('a'), m('b'), m('c')], 3)
  t.is(s.stack.length, 3); t.is(s.overflow, 0)
})

// The one case where +1 is the honest answer: the face is not ours to show.
test('facepileSlice: a face we do not have cannot be absorbed', (t) => {
  const s = facepileSlice([m('a'), m('b'), m('c')], 3, 4)
  t.is(s.stack.length, 3, 'a slim roster ships three names and no fourth avatar')
  t.is(s.overflow, 1, 'so the remainder is still counted')
})

test('facepileSlice: total below what is on hand wins', (t) => {
  const s = facepileSlice([m('a'), m('b'), m('c')], 3, 2)
  t.is(s.stack.length, 2); t.is(s.overflow, 0)
})

test('facepileSlice: guards non-array input and a negative total', (t) => {
  t.alike(facepileSlice(undefined, 3), { stack: [], overflow: 0 })
  t.alike(facepileSlice([m('a')], 3, -5), { stack: [], overflow: 0 })
})

test('peer faces resolve each key against the roster, unknown keys kept as a face with no member', (t) => {
  const bob = { publicKey: 'k2', displayName: 'Bob', avatar: 'data:bob', online: true }
  const faces = peerFaces(['k1', 'k2'], [bob])
  t.alike(faces, [{ key: 'k1', member: null }, { key: 'k2', member: bob }])
  t.alike(peerStackAvatar(faces[1], 'opacity-50'), { key: 'k2', src: 'data:bob', displayName: 'Bob', title: 'Bob', className: 'opacity-50' })
  t.alike(peerStackAvatar(faces[0]), { key: 'k1', src: undefined, displayName: undefined, title: undefined, className: undefined })
  t.is(PEER_STACK_MAX, 3)
})
