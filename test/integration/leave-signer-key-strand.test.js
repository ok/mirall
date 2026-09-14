import test from 'brittle'
import { cleanupSpaceDrives, getBoundSignerKey } from '../../src/shared/transfer/swarm.js'
import { connectedPeers, boundSignerKeys, pendingRequesters, resetRegistries } from '../../src/shared/transfer/swarm-registries.js'

// boundSignerKeys is the ONLY source a membership:grant seals an SCK against (worker/ipc/membership.js
// → boundSignerPk), and sendMembershipGrant cannot tell a stale key from a current one: with no key
// it refuses, with a wrong one it returns success and hands the joiner a grant it can never open.
// That safety rests entirely on the entry existing iff the peer is connected or pending, so the
// leave path — which deletes the peer from connectedPeers itself, before the socket close handler
// that would otherwise finish the teardown — has to forget the key on its way out.

const seed = (key, spaces) => {
  connectedPeers.set(key, {
    socket: { destroy() {} },
    profileKey: key,
    displayName: key,
    spaces: new Map(spaces.map((s) => [s, 'drive-' + s])),
    looseCatalogKeys: new Map(),
  })
  boundSignerKeys.set(key, 'signer-' + key)
}

const leave = (spaceId) => cleanupSpaceDrives(spaceId, [], null, { compact: false })

// REGRESSION (FIX-SIGNER-STRAND): leaving a space dropped the peer from connectedPeers and then
// destroyed its socket, so handleDisconnect's `if (!peer) continue` skipped the rest of the
// per-peer teardown and the signer key was left behind for the process's lifetime.
test('leaving a space forgets the signer key of a peer it leaves in no space', async (t) => {
  resetRegistries()
  t.teardown(() => resetRegistries())
  seed('peer-gone', ['space-a'])

  await leave('space-a')

  t.absent(connectedPeers.has('peer-gone'), 'the peer is gone from the connection registry')
  t.is(getBoundSignerKey('peer-gone'), null, 'and its bound signer key went with it')
})

test('a peer still in another space keeps its signer key through the leave', async (t) => {
  resetRegistries()
  t.teardown(() => resetRegistries())
  seed('peer-stays', ['space-a', 'space-b'])

  await leave('space-a')

  t.ok(connectedPeers.has('peer-stays'), 'still a connected peer — just not here')
  t.is(getBoundSignerKey('peer-stays'), 'signer-peer-stays', 'so its key is still the live one')
})

// The guard has to read the same as handleDisconnect's: a joiner awaiting a grant has no space of
// ours to be in, and dropping its key on our leave would refuse the grant it is waiting for.
test('a pending requester keeps its signer key through the leave', async (t) => {
  resetRegistries()
  t.teardown(() => resetRegistries())
  seed('peer-pending', ['space-a'])
  pendingRequesters.set('peer-pending', { id: 'sock' })

  await leave('space-a')

  t.is(getBoundSignerKey('peer-pending'), 'signer-peer-pending', 'still awaiting its grant')
})
