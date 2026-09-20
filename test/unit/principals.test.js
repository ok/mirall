import test from 'brittle'
import { principalRef } from '../../src/shared/contract/principals.js'

const KEY = 'ab'.repeat(32)
const ORG = 'cd'.repeat(32)

// The grandfathering rule: one install's profile key answers both questions, and the answers
// agree. Asking them apart is legal today and stops being a tautology when a device roster exists.
test('a profile key is both the person and the device, and belongs to no org', (t) => {
  const ref = principalRef(KEY)
  t.is(ref.personKey, KEY, 'whose is this?')
  t.is(ref.deviceKey, KEY, 'which machine?')
  t.is(ref.orgKey, null, 'and no org asserts it')
})

test('an org key is carried when one is supplied', (t) => {
  t.is(principalRef(KEY, ORG).orgKey, ORG)
})

test('the three tiers are separate fields, so a consumer can read one without the others', (t) => {
  t.alike(Object.keys(principalRef(KEY)).sort(), ['deviceKey', 'orgKey', 'personKey'])
})
