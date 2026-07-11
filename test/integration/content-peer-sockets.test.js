import test from 'brittle'
import { createContentPeerSockets } from '../../src/shared/transfer/content-peer-sockets.js'

// REGRESSION (FIX-3: a peer that left the space kept serving it). The content plane rides a second
// Hyperswarm whose sockets the leave path never touched — hyperswarm's leave() un-announces the
// topic but does NOT close established connections, so the overlay channel kept streaming bulk
// bytes for a space we had left. This is the teardown rule that fixes it, and the two ways to get
// it wrong are symmetric: too lax keeps serving an ex-peer, too eager kills a healthy transfer for
// a peer we still share another space with.

const fakeSocket = (name) => ({ name, destroyed: false, destroy () { this.destroyed = true } })

test('destroyFor drops exactly the departing peer\'s sockets and leaves the others alone', (t) => {
  const reg = createContentPeerSockets()
  const aliceSock = fakeSocket('alice')
  const bobSock = fakeSocket('bob')
  reg.add(aliceSock, 'alice-key')
  reg.add(bobSock, 'bob-key')

  t.is(reg.destroyFor('alice-key'), 1, 'one socket dropped')
  t.ok(aliceSock.destroyed, 'the departing peer\'s content socket is destroyed')
  t.absent(bobSock.destroyed, 'a peer we still share a space with keeps its socket (no over-eager teardown)')
  t.absent(reg.authorized(aliceSock, 'alice-key'), 'the dropped socket is forgotten')
  t.ok(reg.authorized(bobSock, 'bob-key'), 'the surviving peer stays authorized')
  t.is(reg.size, 1, 'only the dropped socket left the map')
})

test('destroyFor drops every socket the peer is authenticated on', (t) => {
  const reg = createContentPeerSockets()
  const first = fakeSocket('first')
  const second = fakeSocket('second')
  reg.add(first, 'alice-key')
  reg.add(second, 'alice-key')

  t.is(reg.destroyFor('alice-key'), 2, 'both of the peer\'s sockets are dropped')
  t.ok(first.destroyed && second.destroyed, 'no live content socket survives for a departed peer')
  t.is(reg.size, 0, 'the map is clear')
})

test('a socket carrying several identities is dropped when any one of them departs', (t) => {
  const shared = fakeSocket('shared')
  const reg = createContentPeerSockets()
  reg.add(shared, 'alice-key')
  reg.add(shared, 'carol-key')

  t.ok(reg.authorized(shared, 'carol-key'), 'both identities ride the socket')
  t.is(reg.destroyFor('alice-key'), 1, 'the socket is dropped once, not once per identity')
  t.ok(shared.destroyed, 'destroyed — serving must stop for the departed identity')
  t.is(reg.size, 0, 'and the whole entry is forgotten')
})

test('destroyFor is a safe no-op for an unknown key, and on an empty registry', (t) => {
  const reg = createContentPeerSockets()
  const sock = fakeSocket('alice')
  reg.add(sock, 'alice-key')

  t.is(reg.destroyFor('nobody-key'), 0, 'an unknown peer drops nothing')
  t.absent(sock.destroyed, 'and destroys nothing')
  t.is(createContentPeerSockets().destroyFor('alice-key'), 0, 'empty registry (content plane disabled) is a no-op')
})

test('a socket whose destroy() throws is still forgotten', (t) => {
  const reg = createContentPeerSockets()
  const bad = { destroy () { throw new Error('already gone') } }
  reg.add(bad, 'alice-key')

  t.is(reg.destroyFor('alice-key'), 1, 'counted as dropped')
  t.is(reg.size, 0, 'the map cannot leak a socket we failed to destroy')
})

test('forget clears a closed socket', (t) => {
  const reg = createContentPeerSockets()
  const sock = fakeSocket('alice')
  reg.add(sock, 'alice-key')
  reg.forget(sock)
  t.absent(reg.authorized(sock, 'alice-key'), 'a closed socket authorizes nobody')
  t.is(reg.size, 0)
})
