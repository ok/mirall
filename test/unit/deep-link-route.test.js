import test from 'brittle'
import { encodeInvite } from '../../src/shared/contract/invite-envelope.js'
import { routeDeepLink, EXPIRY_GRACE_MS } from '../../src/renderer/model/deep-link-route.js'

const TOPIC = 'ab'.repeat(32)
const NOW = 1_700_000_000_000
const SPACES = [{ spaceId: 's1', name: 'Aurora', topic: TOPIC }]

test('an undecodable link is invalid', (t) => {
  t.alike(routeDeepLink({ kind: 'join', code: 'not-an-invite' }, SPACES, NOW), { kind: 'invalid' })
})

test('an expired link is reported, with a grace for clock skew', (t) => {
  const stale = encodeInvite({ topic: TOPIC, expiresAt: NOW - EXPIRY_GRACE_MS - 1 })
  t.alike(routeDeepLink({ kind: 'join', code: stale }, [], NOW), { kind: 'expired' })
  const withinGrace = encodeInvite({ topic: TOPIC, expiresAt: NOW - EXPIRY_GRACE_MS })
  t.is(routeDeepLink({ kind: 'join', code: withinGrace }, [], NOW).kind, 'join', 'inside the grace it still joins')
})

test('a link to a space already joined routes to that space', (t) => {
  const code = encodeInvite({ topic: TOPIC, name: 'Aurora' })
  t.alike(routeDeepLink({ kind: 'join', code }, SPACES, NOW), { kind: 'member', space: SPACES[0] })
})

test('a fresh link carries the code and the display name through', (t) => {
  const code = encodeInvite({ topic: 'cd'.repeat(32), name: 'Borealis' })
  t.alike(routeDeepLink({ kind: 'join', code, name: 'Borealis' }, SPACES, NOW), { kind: 'join', code, name: 'Borealis' })
  t.alike(routeDeepLink({ kind: 'join', code }, SPACES, NOW), { kind: 'join', code, name: undefined })
})
