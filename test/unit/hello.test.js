import test from 'brittle'
import { checkHello, refusalMessage } from '../../src/shared/contract/hello.js'
import { IPC_PROTOCOL_VERSION, CLIENT_KINDS, TRUST } from '../../src/shared/contract/ipc-frames.js'

const ok = (over = {}) => ({
  protocolVersion: IPC_PROTOCOL_VERSION,
  client: { kind: 'cli', name: 'mirall', version: '1.2.3' },
  ...over,
})

test('the version is decided before any other field is read', (t) => {
  t.is(checkHello({ client: { kind: 'cli' } }).reason, 'no-version')
  t.is(checkHello({ protocolVersion: 0, client: { kind: 'cli' } }).reason, 'too-old')
  t.is(checkHello(null).reason, 'no-version')
})

test('a client that does not say what it is cannot proceed', (t) => {
  t.is(checkHello(ok({ client: undefined })).reason, 'bad-client')
  t.is(checkHello(ok({ client: { kind: 'browser' } })).reason, 'bad-client')
  for (const kind of CLIENT_KINDS) t.ok(checkHello(ok({ client: { kind } })).ok, `${kind} is accepted`)
})

test('a cursor is absent, well-formed, or refused — never ignored', (t) => {
  t.is(checkHello(ok()).cursor, null, 'no cursor is a client that has read nothing')
  t.alike(checkHello(ok({ cursor: { epoch: null, since: 0 } })).cursor, { epoch: null, since: 0 })
  t.alike(checkHello(ok({ cursor: { epoch: 'e1', since: 5 } })).cursor, { epoch: 'e1', since: 5 })
  const bad = [{ since: 1 }, { epoch: 'e1' }, { epoch: 'e1', since: '5' }, { epoch: 'e1', since: -1 }, { epoch: 7, since: 1 }, 'nope']
  for (const value of bad) t.is(checkHello(ok({ cursor: value })).reason, 'bad-cursor', JSON.stringify(value))
})

test('the declared name and version are bounded, because they are logged', (t) => {
  const verdict = checkHello(ok({ client: { kind: 'cli', name: 'x'.repeat(500), version: 3 } }))
  t.is(verdict.name.length, 64)
  t.is(verdict.version, '', 'a non-string version is dropped rather than stringified')
})

test('the wire vocabularies are frozen', (t) => {
  t.ok(Object.isFrozen(CLIENT_KINDS))
  t.ok(Object.isFrozen(TRUST))
})

// One sentence per refusal, the wire's and this frame's alike: the client is told once and has
// only that sentence to go on.
test('the refusal message names both sides', (t) => {
  const missing = refusalMessage({ reason: 'no-version', theirs: null, ours: 4 })
  t.ok(missing.includes('no protocol version'), 'a versionless host is described as such')
  t.ok(missing.includes('v4'))
  const mismatch = refusalMessage({ reason: 'we-are-newer', theirs: 2, ours: 4 })
  t.ok(mismatch.includes('v2') && mismatch.includes('v4'), 'both versions appear')
  const anonymous = refusalMessage({ reason: 'bad-client', theirs: 2, ours: 2 })
  t.ok(anonymous.includes('did not say what it is'), 'a client that named no kind is described as such')
  const cursor = refusalMessage({ reason: 'bad-cursor', theirs: 2, ours: 2 })
  t.ok(cursor.includes('cursor'), 'and so is one whose cursor could not be read')
})
