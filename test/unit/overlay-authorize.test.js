import test from 'brittle'
import { makeServeAuthorizer } from '../../src/shared/transfer/backends/overlay/overlay-authorize.js'

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
  return { peer, socket, auth: makeServeAuthorizer(deps) }
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
