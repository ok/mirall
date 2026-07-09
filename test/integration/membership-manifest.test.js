import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import {
  markOwnMembership,
  clearOwnMembership,
  readPeerMembership,
  getLocalPublicKeyHex,
} from '../../src/shared/spaces/profile.js'

// The membership manifest is the authenticated signal that drives peer pruning:
// `markOwnMembership` says "I am in this space", `clearOwnMembership` (on leave)
// says "I left". `readPeerMembership` reads it back as a tri-state —
//   true  = member, false = left (cap present, entry gone), null = unknown.
// If `clearOwnMembership` didn't "stick" (still read true), a leaver would
// remain a ghost member in every peer's space; if a never-published manifest
// read as false instead of null, a peer could be pruned before it ever spoke.
// Read against our own key here (single peer); cross-peer propagation is flow.

test('a never-published manifest reads as null (unknown), not false', async (t) => {
  await freshPeer(t)
  const me = getLocalPublicKeyHex()
  t.is(await readPeerMembership(me, 'space-unknown'), null, 'no cap → unknown, never "left"')
})

test('mark → true, then clear → false (the leave sticks)', async (t) => {
  await freshPeer(t)
  const me = getLocalPublicKeyHex()

  await markOwnMembership('space-1')
  t.is(await readPeerMembership(me, 'space-1'), true, 'after mark, reads as a member')

  await clearOwnMembership('space-1')
  t.is(await readPeerMembership(me, 'space-1'), false, 'after clear, reads as left (cap present, entry gone)')
})

test('membership is tracked per space (null is global: no manifest at all)', async (t) => {
  await freshPeer(t)
  const me = getLocalPublicKeyHex()
  await markOwnMembership('space-a')
  await markOwnMembership('space-b')
  await clearOwnMembership('space-a')

  t.is(await readPeerMembership(me, 'space-a'), false, 'left space-a')
  t.is(await readPeerMembership(me, 'space-b'), true, 'still in space-b')
  // The cap is global, not per-space: once any membership is published, a
  // never-joined space reads `false` (cap present, no entry), not `null`.
  // `null` only ever means "this peer has no membership manifest at all".
  t.is(await readPeerMembership(me, 'space-c'), false, 'never joined space-c, but cap exists → not a member')
})
