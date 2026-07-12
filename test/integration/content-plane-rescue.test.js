import test from 'brittle'
import { createContentPeerSockets } from '../../src/shared/transfer/content-peer-sockets.js'

// REGRESSION (FIX-9, second root cause: the bulk plane stops re-dialing and never recovers).
//
// Hyperswarm only keeps re-dialing a peer whose connections live long enough to prove themselves.
// On a link that keeps dropping inside that window the attempt counter never resets, and after the
// fourth short-lived close the peer loses its retry timer outright — the next automatic dial is a
// topic re-lookup ten minutes later. The control plane survives that because the convergence tick
// can refresh its discovery; the content plane had no such lever at all (its only refresh hung off
// the user pressing Reconnect), so a stalled transfer stayed dead.
//
// hasPeer is what lets the tick SEE the stall: a pending download whose owner has no content socket
// left is the signal to refresh discovery, which resets hyperswarm's attempts and re-dials now.

const fakeSocket = (name) => ({ name, destroyed: false, destroy () { this.destroyed = true } })

test('hasPeer reports whether an owner is still reachable on any content socket', (t) => {
  const reg = createContentPeerSockets()
  const sock = fakeSocket('alice')

  t.absent(reg.hasPeer('alice-key'), 'unknown peer is not reachable')
  reg.add(sock, 'alice-key')
  t.ok(reg.hasPeer('alice-key'), 'reachable once authenticated on a socket')
  t.absent(reg.hasPeer('bob-key'), 'a different peer is still not reachable')
})

test('a dropped content socket makes its owner unreachable — the stall the tick must see', (t) => {
  const reg = createContentPeerSockets()
  const sock = fakeSocket('alice')
  reg.add(sock, 'alice-key')

  reg.forget(sock) // what the socket's own 'close' does
  t.absent(reg.hasPeer('alice-key'),
    'after the link drops, the owner has no content socket — a transfer pending on them is stalled')
})

test('hasPeer survives a peer authenticated on several sockets until the last one goes', (t) => {
  const reg = createContentPeerSockets()
  const first = fakeSocket('first')
  const second = fakeSocket('second')
  reg.add(first, 'alice-key')
  reg.add(second, 'alice-key')

  reg.forget(first)
  t.ok(reg.hasPeer('alice-key'), 'still reachable on the surviving socket — not a stall')
  reg.forget(second)
  t.absent(reg.hasPeer('alice-key'), 'the last socket is gone — now it is a stall')
})

test('destroyFor (a peer we no longer share a space with) leaves them unreachable', (t) => {
  const reg = createContentPeerSockets()
  reg.add(fakeSocket('alice'), 'alice-key')
  reg.add(fakeSocket('bob'), 'bob-key')

  reg.destroyFor('alice-key')
  t.absent(reg.hasPeer('alice-key'), 'the departed peer is unreachable')
  t.ok(reg.hasPeer('bob-key'), 'a peer we still share a space with stays reachable')
})
