import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'

// Proves the two-peer harness foundation: the real worker boots as a bare
// subprocess via bare-sidecar, completes bootstrap, and answers IPC.
test('a worker boots under bare-sidecar and answers ping', async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const res = await peer.request('ping')
  t.ok(res && res.pong, 'ping answered with pong')
})

test('two workers boot independently on the same testnet', async (t) => {
  const bootstrap = await localTestnet(t)
  const a = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const b = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  t.ok((await a.request('ping')).pong)
  t.ok((await b.request('ping')).pong)
  const spacesA = await a.request('spaces:list')
  t.alike(spacesA, [], 'fresh peer has no spaces')
})
