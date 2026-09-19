import test from 'brittle'
import { checkProtocolCompatibility, protocolMismatchMessage } from '../../src/shared/contract/protocol-compat.js'
import { IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED } from '../../src/shared/contract/ipc-frames.js'

test('a matching version is compatible', (t) => {
  t.alike(
    checkProtocolCompatibility({ protocolVersion: 1, protocolMin: 1, protocolMax: 1 }, { version: 1, min: 1 }),
    { ok: true, reason: null, theirs: 1, ours: 1 },
  )
})

test('the shipped constants agree with themselves', (t) => {
  const frame = {
    protocolVersion: IPC_PROTOCOL_VERSION,
    protocolMin: IPC_PROTOCOL_MIN_SUPPORTED,
    protocolMax: IPC_PROTOCOL_VERSION,
  }
  t.is(checkProtocolCompatibility(frame).ok, true, 'the frame main sends is one this build accepts')
})

test('a frame with no protocolVersion is refused, not defaulted', (t) => {
  const verdict = checkProtocolCompatibility({ storage: '/tmp' })
  t.is(verdict.ok, false)
  t.is(verdict.reason, 'no-version')
  t.is(verdict.theirs, null)
})

test('a host older than our floor is refused', (t) => {
  t.is(checkProtocolCompatibility({ protocolVersion: 1 }, { version: 3, min: 2 }).reason, 'too-old')
})

test('a host whose ceiling is below our floor is refused', (t) => {
  // Reachable only for a host whose window contradicts its own version — its ceiling sits below a
  // floor its version clears. The version alone is the thing lying, so the window decides.
  t.is(checkProtocolCompatibility({ protocolVersion: 5, protocolMax: 2 }, { version: 4, min: 3 }).reason, 'we-are-newer')
})

test('REGRESSION (FIX-400-2): a build that still supports an older wire accepts a host on it', (t) => {
  // min is the only lever that can WIDEN acceptance. Comparing the host's ceiling against our
  // current version instead of our floor made it inert: a v2 build with min 1 refused every v1
  // host and parked the user on the fault screen.
  t.is(checkProtocolCompatibility({ protocolVersion: 1, protocolMax: 1 }, { version: 2, min: 1 }).ok, true)
  t.is(checkProtocolCompatibility({ protocolVersion: 1 }, { version: 2, min: 1 }).ok, true,
    'including a host that advertises no window at all')
})

test('a host whose floor is above us is refused', (t) => {
  t.is(checkProtocolCompatibility({ protocolVersion: 3, protocolMin: 3 }, { version: 2, min: 1 }).reason, 'we-are-older')
})

test('a host that advertises a window we sit inside is accepted', (t) => {
  t.is(checkProtocolCompatibility({ protocolVersion: 3, protocolMin: 1, protocolMax: 3 }, { version: 2, min: 1 }).ok, true)
})

test('a non-integer version is not a version', (t) => {
  t.is(checkProtocolCompatibility({ protocolVersion: '1' }).reason, 'no-version')
  t.is(checkProtocolCompatibility({ protocolVersion: 1.5 }).reason, 'no-version')
  t.is(checkProtocolCompatibility(null).reason, 'no-version')
})

test('the refusal message names both sides', (t) => {
  const missing = protocolMismatchMessage({ reason: 'no-version', theirs: null, ours: 4 })
  t.ok(missing.includes('no protocol version'), 'a versionless host is described as such')
  t.ok(missing.includes('v4'))
  const mismatch = protocolMismatchMessage({ reason: 'we-are-newer', theirs: 2, ours: 4 })
  t.ok(mismatch.includes('v2') && mismatch.includes('v4'), 'both versions appear')
})
