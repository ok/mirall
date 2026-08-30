import test from 'brittle'
import { createHandlerTable, validateArgs } from '../../src/shared/core/handler-table.js'
import { ARG, REQUESTS } from '../../src/shared/contract/requests.js'

const REQ = Object.freeze({
  'thing:get': { kind: 'query', args: {} },
  'thing:do': { kind: 'command', args: { spaceId: { type: ARG.spaceId }, note: { type: ARG.string, optional: true, max: 5 } } },
})

test('registering a request the contract does not declare throws', (t) => {
  const table = createHandlerTable({ requests: REQ })
  let threw = null
  try { table.register('thing:nope', () => {}) } catch (err) { threw = err }
  t.ok(threw, 'refused')
  t.ok(/does not declare/.test(threw.message), 'and says why — a typo becomes a boot failure, not a field 404')
})

test('registering the same request twice throws', (t) => {
  const table = createHandlerTable({ requests: REQ })
  table.register('thing:get', () => {})
  let threw = null
  try { table.register('thing:get', () => {}) } catch (err) { threw = err }
  t.ok(threw, 'a duplicate is a wiring bug, not a silent overwrite')
})

test('the table carries the spec alongside the function', (t) => {
  const table = createHandlerTable({ requests: REQ })
  const fn = () => 'v'
  table.register('thing:do', fn)
  const entry = table.get('thing:do')
  t.is(entry.fn, fn)
  t.is(entry.spec.kind, 'command', 'the router can read the kind without the entrypoint telling it')
  t.is(table.size(), 1)
  t.absent(table.get('thing:get'), 'an unregistered request has no entry')
})

test('validateArgs accepts a well-formed payload', (t) => {
  t.is(validateArgs(REQ['thing:do'].args, { spaceId: 's1', note: 'ok' }), null)
  t.is(validateArgs(REQ['thing:do'].args, { spaceId: 's1' }), null, 'an optional field may be absent')
  t.is(validateArgs({}, {}), null, 'a no-input request validates trivially')
})

test('validateArgs rejects the shapes a handler body used to discover', (t) => {
  t.is(validateArgs(REQ['thing:do'].args, {}), 'missing required field: spaceId')
  t.is(validateArgs(REQ['thing:do'].args, { spaceId: 42 }), 'spaceId must be a string')
  t.is(validateArgs(REQ['thing:do'].args, { spaceId: 's', note: 'toolong' }), 'note exceeds 5 characters')
  t.is(validateArgs(REQ['thing:do'].args, { spaceId: 's', note: 7 }), 'note must be a string',
    'an optional field may be absent but not wrong-typed')
})

test('validateArgs checks each declared arg type', (t) => {
  t.is(validateArgs({ n: { type: ARG.number } }, { n: 1 }), null)
  t.is(validateArgs({ n: { type: ARG.number } }, { n: '1' }), 'n must be a number')
  t.is(validateArgs({ n: { type: ARG.number } }, { n: NaN }), 'n must be a number', 'NaN is not a number here')
  t.is(validateArgs({ b: { type: ARG.boolean } }, { b: false }), null, 'false is a value, not an absence')
  t.is(validateArgs({ b: { type: ARG.boolean } }, { b: 'no' }), 'b must be a boolean')
  t.is(validateArgs({ a: { type: ARG.array } }, { a: [] }), null)
  t.is(validateArgs({ a: { type: ARG.array } }, { a: 'x' }), 'a must be an array')
  t.is(validateArgs({ a: { type: ARG.array } }, { a: {} }), 'a must be an array', 'an object is not an array')
})

test('null and undefined are treated as absent, not as values', (t) => {
  t.is(validateArgs({ x: { type: ARG.string, optional: true } }, { x: null }), null)
  t.is(validateArgs({ x: { type: ARG.string } }, { x: undefined }), 'missing required field: x')
})

// A type the validator does not know used to fall through `default: return null` and validate
// nothing, silently — on the injectable-requests seam that would mean a whole test contract with no
// checking and no signal.
test('an unknown arg type is a loud failure, not a silent pass', (t) => {
  let threw = null
  try { validateArgs({ k: { type: 'nonsense' } }, { k: 1 }) } catch (err) { threw = err }
  t.ok(threw, 'refused')
  t.ok(/unknown arg type/.test(threw.message), 'and names the problem')
})

// The requiredness policy is deliberate and was learned the hard way: marking spaceId/shareId
// required broke three real flows. This pins the policy so a future edit has to be intentional.
test('no contract row demands a field', (t) => {
  const offenders = []
  for (const [name, spec] of Object.entries(REQUESTS)) {
    for (const [field, rule] of Object.entries(spec.args)) {
      if (!rule.optional) offenders.push(`${name}.${field}`)
    }
  }
  t.alike(offenders, [], 'a required field needs evidence that every caller supplies it — see requests.js')
})
