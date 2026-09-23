import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { until } from '../helpers/poll.js'
import { localRelay, relayFlags, flags, idStore, bothPlanesSettled } from '../helpers/local-relay.js'
import { MEMBER_REACH } from '../../src/shared/contract/member-reach.js'

test('members:reach names every connected member and drops one that quits', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B, 'Aurora')
  const aKey = (await A.request('profile:get')).personKey
  const bKey = (await B.request('profile:get')).personKey

  const reachA = await A.until('members:reach', { spaceId }, (r) => r.members[bKey] === 'direct')
  t.absent(aKey in reachA.members, 'self has no reach entry — there is no socket to oneself')
  await B.until('members:reach', { spaceId }, (r) => r.members[aKey] === 'direct')

  B.kill()
  await A.until('members:reach', { spaceId }, (r) => !(bKey in r.members), { ms: 60000 })
  await A.until('members:online', { spaceId }, (o) => !o.includes(bKey), { ms: 60000 })
  t.pass('a departed member leaves the reach map, as it leaves the presence lease')
})

// Neither outcome can be demanded of a loopback pairing: hyperdht keeps punching underneath it and
// moves the same socket direct when the punch lands, which here it usually does. What IS demanded
// is that the roster agrees with the live frame — a person some socket carries through a relay
// reads relayed, a person no relayed socket carries reads direct — because that agreement is the
// whole feature, and neither a roster that never learns of a pairing nor one left on a stale
// relayed after the upgrade ever reaches it.
test('the roster names the path the frame says a member is reached over', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const relay = await localRelay(t, bootstrap)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: relayFlags(relay.key) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).personKey
  const bKey = (await B.request('profile:get')).personKey

  await A.until('network:status:get', {}, bothPlanesSettled, { ms: 30000 })
  await B.until('network:status:get', {}, bothPlanesSettled, { ms: 30000 })

  t.comment(`A: ${await agreesWithFrame(t, A, spaceId, bKey)}`)
  t.comment(`B: ${await agreesWithFrame(t, B, spaceId, aKey)}`)
})

// Both facts are read together and re-read until they match: a disagreement is either a sample
// taken mid-upgrade, which the next pass clears, or a roster that stopped re-deriving, which no
// pass clears. Only the second outlasts the deadline.
async function agreesWithFrame(t, peer, spaceId, personKey) {
  let sample = 'nothing sampled'
  const agreed = await until(async () => {
    const frame = await peer.request('network:status:get', {})
    const reach = (await peer.request('members:reach', { spaceId })).members[personKey]
    const relayed = frame.relay.connections.some((c) => c.personKey === personKey)
    sample = `the roster reads ${reach}, ${relayed ? 'a socket is paired through the relay' : 'no socket is paired'}`
    return reach === (relayed ? MEMBER_REACH.RELAYED : MEMBER_REACH.DIRECT)
  }, 30000, { interval: 250 })
  t.ok(agreed, `the roster names the path the frame names — ${sample}`)
  return sample
}
