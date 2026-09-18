import test from 'brittle'
import { relayMismatch } from '../../src/shared/contract/relay-apply.js'
import { relayApplyNotice } from '../../src/renderer/model/relay-apply.js'

const facts = (over = {}) => ({ connections: [], direct: { control: 0, content: 0 }, ...over })
const own = { via: 'own' }
const adopted = { via: 'adopted' }

test('off with a connection still on OUR relay is a mismatch', (t) => {
  t.is(relayMismatch('off', facts({ connections: [own] })), 'stale-relayed')
  t.is(relayMismatch('off', facts()), null)
})

// hyperdht relays when EITHER side offers a relay, so no local act can end a connection the peer is
// relaying. Offering one would be a promise the transport cannot keep.
test('off with only an ADOPTED relay is not', (t) => {
  t.is(relayMismatch('off', facts({ connections: [adopted] })), null)
  t.is(relayMismatch('off', facts({ connections: [adopted, own] })), 'stale-relayed')
})

test('always with any live direct connection is a mismatch', (t) => {
  t.is(relayMismatch('always', facts({ direct: { control: 1, content: 0 } })), 'stale-direct')
  t.is(relayMismatch('always', facts({ direct: { control: 0, content: 1 } })), 'stale-direct')
  t.is(relayMismatch('always', facts({ connections: [own, adopted] })), null)
})

// A relayed connection under auto is the feature working and a direct one is the better outcome.
// Reporting either would be the nag that trains people to ignore the notice.
test('auto is never a mismatch', (t) => {
  const cases = [facts({ connections: [own] }), facts({ connections: [adopted] }), facts({ direct: { control: 2, content: 2 } })]
  for (const f of cases) t.is(relayMismatch('auto', f), null)
})

test('no facts yet is not a mismatch', (t) => {
  t.is(relayMismatch('always', null), null)
  t.is(relayMismatch('off', undefined), null)
})

test('a pending identity outranks every other verdict', (t) => {
  t.is(relayApplyNotice({ mode: 'always', relay: facts(), armed: false, pendingIdentity: true }), 'restart')
  t.is(relayApplyNotice({ mode: 'auto', relay: null, armed: false, pendingIdentity: true }), 'restart')
})

test('nothing is said until the worker reports it could not apply the change', (t) => {
  const state = { mode: 'off', relay: facts({ connections: [own] }), pendingIdentity: false }
  t.is(relayApplyNotice({ ...state, armed: false }), null)
  t.is(relayApplyNotice({ ...state, armed: true }), 'stale-relayed')
})

// Armed is necessary, not sufficient: peers cycling on their own resolve the mismatch, and the
// notice has to go with it rather than wait for an act that is no longer needed.
test('an armed change with no live mismatch says nothing', (t) => {
  t.is(relayApplyNotice({ mode: 'always', relay: facts({ connections: [own] }), armed: true, pendingIdentity: false }), null)
  t.is(relayApplyNotice({ mode: 'off', relay: facts({ direct: { control: 2, content: 0 } }), armed: true, pendingIdentity: false }), null)
})
