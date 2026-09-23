import test from 'brittle'
import { memberReach } from '../../src/shared/network/member-reach.js'

const A = 'a1'.repeat(32)
const B = 'b1'.repeat(32)
const sock = (relayed) => ({ relayed })
const isRelayed = (s) => s.relayed === true

test('a member is direct when every live socket is direct', (t) => {
  t.alike(memberReach([[A, [sock(false), sock(false)]]], isRelayed), { [A]: 'direct' })
})

test('a member is relayed when any plane runs through a relay', (t) => {
  t.alike(
    memberReach([[A, [sock(false), sock(true)]], [B, [sock(false)]]], isRelayed),
    { [A]: 'relayed', [B]: 'direct' },
    'one relayed socket decides that person, and does not leak onto anyone else',
  )
})

test('a member with no live socket is absent, not direct', (t) => {
  t.alike(memberReach([[A, [null, undefined]]], isRelayed), {}, 'a lease with no socket claims nothing')
  t.alike(memberReach([[A, []]], isRelayed), {})
})

test('the fold is total over the entries it is given', (t) => {
  t.alike(memberReach([], isRelayed), {})
})
