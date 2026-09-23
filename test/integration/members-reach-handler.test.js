import test from 'brittle'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { OWN, Stub, socketOf } from '../helpers/relayed-socket.js'
import { registerSpaces } from '../../src/worker/ipc/spaces.js'
import { connectedPeers, resetRegistries } from '../../src/shared/network/swarm-registries.js'
import { installRelayObserver, resetRelayObserver } from '../../src/shared/network/relay-observe.js'
import {
  initRelayedConnections, resetRelayedConnections, trackConnection,
} from '../../src/shared/network/relayed-connections.js'

const SPACE = 's'.repeat(64)
const OTHER_SPACE = 'f'.repeat(64)
const ALICE = 'a1'.repeat(32)
const BOB = 'b1'.repeat(32)
const CARA = 'c1'.repeat(32)

function seed(personKey, socket, spaceId) {
  connectedPeers.set(personKey, {
    socket, profileKey: personKey, displayName: personKey.slice(0, 4), avatar: null,
    spaces: new Map([[spaceId, null]]), looseCatalogKeys: new Map(),
  })
}

function setup(t) {
  const fake = createFakeIpc()
  registerSpaces(fake.ipc, { log: console, publishDownloadRoots: () => {} })
  installRelayObserver({ Client: Stub })
  initRelayedConnections({ ownRelay: () => ({ key: OWN, label: null }), onChange: () => {} })
  t.teardown(() => { resetRegistries(); resetRelayedConnections(); resetRelayObserver() })
  return fake
}

test('members:reach folds the control socket of every member of the space', async (t) => {
  const fake = setup(t)
  const relayed = socketOf({ relayKey: OWN })
  const direct = socketOf()
  trackConnection(relayed, { plane: 'control', memberOf: () => null })
  trackConnection(direct, { plane: 'control', memberOf: () => null })
  seed(ALICE, relayed, SPACE)
  seed(BOB, direct, SPACE)
  seed(CARA, relayed, OTHER_SPACE)

  const res = await fake.call('members:reach', { spaceId: SPACE })
  t.alike(res, { members: { [ALICE]: 'relayed', [BOB]: 'direct' } },
    'a member of another space is not listed, and self is never here')
})

test('a member whose socket punched through reads direct again', async (t) => {
  const fake = setup(t)
  const socket = socketOf({ relayKey: OWN })
  trackConnection(socket, { plane: 'control', memberOf: () => null })
  seed(ALICE, socket, SPACE)
  t.is((await fake.call('members:reach', { spaceId: SPACE })).members[ALICE], 'relayed')

  socket.rawStream.remoteHost = '198.51.100.1'
  socket.rawStream.emit('remote-changed')
  t.is((await fake.call('members:reach', { spaceId: SPACE })).members[ALICE], 'direct',
    'the roster follows the upgrade; it does not cache the pairing')
})

test('a member with no live socket is absent from the map', async (t) => {
  const fake = setup(t)
  seed(ALICE, null, SPACE)
  t.alike((await fake.call('members:reach', { spaceId: SPACE })).members, {})
})
