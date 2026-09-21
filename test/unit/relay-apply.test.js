import test from 'brittle'
import { relayMismatch } from '../../src/shared/contract/relay-apply.js'
import { relayApplyNotice } from '../../src/renderer/model/relay-apply.js'

const facts = (over = {}) => ({ connections: [], direct: { control: 0, content: 0 }, ...over })
const own = (relayMode = 'always') => ({ via: 'own', relayMode })
const adopted = (relayMode = 'always') => ({ via: 'adopted', relayMode })

test('off with a connection still on OUR relay is a mismatch', (t) => {
  t.is(relayMismatch('off', facts({ connections: [own()] })), 'stale-relayed')
  t.is(relayMismatch('off', facts()), null)
})

// hyperdht relays when EITHER side offers a relay, so no local act can end a connection the peer is
// relaying. Offering one would be a promise the transport cannot keep.
test('off with only an ADOPTED relay is not', (t) => {
  t.is(relayMismatch('off', facts({ connections: [adopted()] })), null)
  t.is(relayMismatch('off', facts({ connections: [adopted(), own()] })), 'stale-relayed')
})

test('always with any live direct connection is a mismatch', (t) => {
  t.is(relayMismatch('always', facts({ direct: { control: 1, content: 0 } })), 'stale-direct')
  t.is(relayMismatch('always', facts({ direct: { control: 0, content: 1 } })), 'stale-direct')
  t.is(relayMismatch('always', facts({ connections: [own(), adopted()] })), null)
})

// REGRESSION (FIX-411: switching `always` → `auto` left every connection `always` had relayed on our
// relay — the rule read only the current mode, and `auto` accepts any relayed connection.)
test('REGRESSION (FIX-411: auto with a connection relayed under always is stale-relayed)', (t) => {
  t.is(relayMismatch('auto', facts({ connections: [own('always')] })), 'stale-relayed')
  t.is(relayMismatch('auto', facts({ connections: [own('auto'), own('always')] })), 'stale-relayed')
})

// A relayed connection built under auto is the feature working and a direct one is the better
// outcome. Reporting either would be the nag that trains people to ignore the notice.
test('auto accepts connections it built itself, and direct ones', (t) => {
  const cases = [
    facts({ connections: [own('auto')] }),
    facts({ direct: { control: 2, content: 2 } }),
    facts({ connections: [own('auto')], direct: { control: 1, content: 0 } }),
  ]
  for (const f of cases) t.is(relayMismatch('auto', f), null)
})

// hyperdht relays when EITHER side offers one, so a relay the peer supplied is not ours to end —
// whatever mode we were in when it paired.
test('auto never flags an ADOPTED relay, whatever mode it paired under', (t) => {
  t.is(relayMismatch('auto', facts({ connections: [adopted('always')] })), null)
  t.is(relayMismatch('auto', facts({ connections: [adopted('always'), own('auto')] })), null)
})

// `off` can be the stamp too: a peer handing our own key back relays through us with the mode off.
test('auto does not flag a connection stamped off', (t) => {
  t.is(relayMismatch('auto', facts({ connections: [own('off')] })), null)
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
  const state = { mode: 'off', relay: facts({ connections: [own()] }), pendingIdentity: false }
  t.is(relayApplyNotice({ ...state, armed: false }), null)
  t.is(relayApplyNotice({ ...state, armed: true }), 'stale-relayed')
})

// Armed is necessary, not sufficient: peers cycling on their own resolve the mismatch, and the
// notice has to go with it rather than wait for an act that is no longer needed.
test('an armed change with no live mismatch says nothing', (t) => {
  t.is(relayApplyNotice({ mode: 'always', relay: facts({ connections: [own()] }), armed: true, pendingIdentity: false }), null)
  t.is(relayApplyNotice({ mode: 'off', relay: facts({ direct: { control: 2, content: 0 } }), armed: true, pendingIdentity: false }), null)
})

test('REGRESSION (FIX-411: an armed always→auto change raises the notice until the connections cycle)', (t) => {
  const stale = { mode: 'auto', relay: facts({ connections: [own('always')] }), pendingIdentity: false }
  t.is(relayApplyNotice({ ...stale, armed: true }), 'stale-relayed')
  t.is(relayApplyNotice({ ...stale, armed: false }), null, 'nothing until the worker says it could not apply it')
  const cycled = { ...stale, relay: facts({ connections: [own('auto')] }) }
  t.is(relayApplyNotice({ ...cycled, armed: true }), null, 'reconnected connections carry auto and clear it')
})
