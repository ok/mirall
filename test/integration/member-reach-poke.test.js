import test from 'brittle'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { OWN, Stub, socketOf } from '../helpers/relayed-socket.js'
import { connectedPeers, resetRegistries } from '../../src/shared/network/swarm-registries.js'
import { installRelayObserver, resetRelayObserver } from '../../src/shared/network/relay-observe.js'
import { trackConnection, resetRelayedConnections } from '../../src/shared/network/relayed-connections.js'
import { initRelayInstall, resetRelayInstall } from '../../src/shared/network/relay-install.js'
import {
  initHandshakeApply, pokeMemberSpaces, membersPoke, resetHandshakeApply,
} from '../../src/shared/network/handshake-apply.js'
import { waitFor } from '../helpers/bare-poll.js'

const SPACE = 's'.repeat(64)
const ALICE = 'a1'.repeat(32)

test('a stream leaving its relay pokes the members scope of every space that person is in', async (t) => {
  const fake = createFakeIpc()
  installRelayObserver({ Client: Stub })
  initHandshakeApply({ getIpc: () => fake.ipc })
  initRelayInstall({ getSwarm: () => null, onStatusChange: () => {}, onReachChange: pokeMemberSpaces })
  t.teardown(() => {
    membersPoke.reset(); resetHandshakeApply(); resetRelayInstall()
    resetRelayedConnections(); resetRelayObserver(); resetRegistries()
  })

  const member = { profileKey: ALICE, displayName: 'Alice' }
  const socket = socketOf({ relayKey: OWN })
  trackConnection(socket, { plane: 'control', memberOf: () => member })
  connectedPeers.set(ALICE, {
    socket, profileKey: ALICE, displayName: 'Alice', avatar: null,
    spaces: new Set([SPACE]), looseCatalogKeys: new Map(),
  })

  socket.rawStream.remoteHost = '198.51.100.1'
  socket.rawStream.emit('remote-changed')

  // membersPoke coalesces at 250 ms, so the frame is awaited rather than asserted synchronously.
  await waitFor(
    () => fake.emitted('event:members-updated').some((e) => e.payload.spaceId === SPACE),
    5000, { label: 'the roster scope to be poked' },
  )
  t.pass('the upgrade reaches the scope the badge re-derives on')
})
