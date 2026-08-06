import test from 'brittle'
import { makeServeAuthorizer, DENY, SECURITY_DENIALS } from '../../src/shared/transfer/backends/overlay/overlay-authorize.js'

// Build the authorizer with controllable fakes for each collaborator. Defaults
// are the "everything passes" case; each test overrides one leg to drive a deny.
function build (overrides = {}) {
  const socket = { id: 'sock' }
  const peer = { id: 'peer' }
  const peerSocket = new Map([[peer, socket]])
  const deps = {
    peerSocket,
    socketAuthorized: overrides.socketAuthorized || (() => true),
    isApprovedMember: overrides.isApprovedMember || (async () => true),
    serveLimiter: overrides.serveLimiter || { take: () => ({ ok: true }) },
    serveIndex: overrides.serveIndex || { spacesFor: () => ['space1'] },
  }
  const denials = []
  deps.onDeny = (reason, ctx) => denials.push({ reason, ...ctx })
  return { peer, socket, auth: makeServeAuthorizer(deps), denials }
}

test('(a) unknown peer (not attached on a socket) → deny', async (t) => {
  const { auth } = build()
  t.is(await auth({ id: 'stranger' }, 'fromKey', 'hash'), false)
})

test('(b) from not Noise-authenticated on the socket → deny', async (t) => {
  const { peer, auth } = build({ socketAuthorized: () => false })
  t.is(await auth(peer, 'fromKey', 'hash'), false)
})

test('(b2) missing/empty from → deny', async (t) => {
  const { peer, auth } = build()
  t.is(await auth(peer, null, 'hash'), false)
  t.is(await auth(peer, '', 'hash'), false)
})

test('(c) authenticated but not an approved member → deny', async (t) => {
  const { peer, auth } = build({ isApprovedMember: async () => false })
  t.is(await auth(peer, 'fromKey', 'hash'), false)
})

test('(c2) authenticated member but hash advertised by no space → deny', async (t) => {
  const { peer, auth } = build({ serveIndex: { spacesFor: () => [] } })
  t.is(await auth(peer, 'fromKey', 'hash'), false)
})

test('(d) approved member of an advertising space → allow', async (t) => {
  const { peer, auth } = build()
  t.is(await auth(peer, 'fromKey', 'hash'), true)
})

test('(d2) approved member of ONE of several advertising spaces → allow', async (t) => {
  const { peer, auth } = build({
    serveIndex: { spacesFor: () => ['s1', 's2', 's3'] },
    isApprovedMember: async (spaceId) => spaceId === 's3',
  })
  t.is(await auth(peer, 'fromKey', 'hash'), true)
})

test('(e) rate-limit trips after burst → deny', async (t) => {
  let n = 0
  const { peer, auth } = build({ serveLimiter: { take: () => ({ ok: ++n <= 2 }) } })
  t.is(await auth(peer, 'fromKey', 'hash'), true)
  t.is(await auth(peer, 'fromKey', 'hash'), true)
  t.is(await auth(peer, 'fromKey', 'hash'), false, 'third request rate-limited')
})

test('rate limit is consulted before the (async) membership check', async (t) => {
  let memberChecked = false
  const { peer, auth } = build({
    serveLimiter: { take: () => ({ ok: false }) },
    isApprovedMember: async () => { memberChecked = true; return true },
  })
  t.is(await auth(peer, 'fromKey', 'hash'), false)
  t.absent(memberChecked, 'membership not consulted once rate-limited')
})

// The serve epoch re-validates a grant WE already issued (not an inbound request), so it must skip
// the limiter — otherwise bumping the epoch while a peer legitimately pulls many files would revoke
// healthy transfers for being numerous.
test('rateLimit:false skips the limiter but still enforces membership', async (t) => {
  let taken = 0
  const { peer, auth } = build({
    serveLimiter: { take: () => { taken++; return { ok: false } } },
    isApprovedMember: async () => true,
  })
  t.is(await auth(peer, 'fromKey', 'hash', { rateLimit: false }), true, 're-validation is allowed without charging the limiter')
  t.is(taken, 0, 'the limiter was not consulted on re-validation')

  const denied = build({ serveLimiter: { take: () => ({ ok: true }) }, isApprovedMember: async () => false })
  t.is(await denied.auth(denied.peer, 'fromKey', 'hash', { rateLimit: false }), false, 'a non-member is still denied on re-validation')
})

// Each gate must be distinguishable. Only two of the four mean "access refused"; treating the
// other two as security events buried the log in "A file request was refused" during an ordinary
// folder mirror, where a busy peer routinely trips the per-requester budget.
test('each gate reports a distinct denial reason', async (t) => {
  const stranger = build()
  await stranger.auth({ id: 'unattached' }, 'k', 'h')
  t.is(stranger.denials[0].reason, DENY.NO_SOCKET)

  const unauth = build({ socketAuthorized: () => false })
  await unauth.auth(unauth.peer, 'k', 'h')
  t.is(unauth.denials[0].reason, DENY.UNAUTHENTICATED)

  const limited = build({ serveLimiter: { take: () => ({ ok: false }) } })
  await limited.auth(limited.peer, 'k', 'h')
  t.is(limited.denials[0].reason, DENY.RATE_LIMITED)

  const outsider = build({ isApprovedMember: async () => false })
  await outsider.auth(outsider.peer, 'k', 'h')
  t.is(outsider.denials[0].reason, DENY.NOT_A_MEMBER)
})

test('only genuine refusals count as security denials', (t) => {
  t.ok(SECURITY_DENIALS.has(DENY.UNAUTHENTICATED))
  t.ok(SECURITY_DENIALS.has(DENY.NOT_A_MEMBER))
  t.absent(SECURITY_DENIALS.has(DENY.RATE_LIMITED), 'flow control is not an access refusal')
  t.absent(SECURITY_DENIALS.has(DENY.NO_SOCKET), 'a teardown race is not an access refusal')
})

test('the denial carries the requester and hash so a row can name them', async (t) => {
  const { auth, peer, denials } = build({ isApprovedMember: async () => false })
  await auth(peer, 'peerKey', 'contentHash')
  t.is(denials[0].from, 'peerKey')
  t.is(denials[0].contentHash, 'contentHash')
})

test('a granted serve reports no denial at all', async (t) => {
  const { auth, peer, denials } = build()
  t.is(await auth(peer, 'k', 'h'), true)
  t.is(denials.length, 0)
})

test('an onDeny that throws can never break the gate', async (t) => {
  const deps = {
    peerSocket: new Map(),
    socketAuthorized: () => true,
    isApprovedMember: async () => true,
    serveLimiter: { take: () => ({ ok: true }) },
    serveIndex: { spacesFor: () => ['space1'] },
    onDeny: () => { throw new Error('audit exploded') },
  }
  const auth = makeServeAuthorizer(deps)
  t.is(await auth({ id: 'x' }, 'k', 'h'), false, 'the gate still returns its verdict')
})
