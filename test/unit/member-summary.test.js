import test from 'brittle'
import { summarizeMembers } from '../../src/renderer/memberSummary.js'

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
