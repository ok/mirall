import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import b4a from 'b4a'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { rawPeer } from '../helpers/raw-peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { encodeInvite, HEX64 } from '../../src/shared/contract/invite-envelope.js'
import { sealSck } from '../../src/shared/spaces/sck-seal.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const hex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
// Identity mode with binding enforcement at its shipped default (off), which is what lets a raw
// peer stand in for a granter.
const v2flags = () => ({ identityKEK: kekHex() })

const spaceOf = async (peer, spaceId) => (await peer.request('spaces:list')).find((s) => s.spaceId === spaceId)

// The raw peer's connection wait has no deadline of its own; a discovery that never happens must
// fail the test with a name, not run out the whole budget.
function withDeadline(promise, ms, label) {
  let timer
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms) })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// The SCK epoch is additive on the wire. A grant from a release that predates the field carries
// no `epoch`, and the joiner must read it as epoch 0 — accepted, stored at 0, and the space flips
// to approved — rather than refuse it and stay pending forever; a grant whose epoch is malformed
// is a malformed frame and is refused. The raw peer plays the granter: it reads the joiner's
// signer key off the join request every pending peer announces, seals a key to it, and sends the
// grant frames itself. Both cases ride one connection, in one test, so the second never depends
// on a second discovery.
test('a grant with a malformed epoch is refused; one with no epoch field (an older granter) is accepted as epoch 0', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const topic = hex()
  const creator = hex()
  await B.request('space:join', { inviteCode: encodeInvite({ topic, creator, schemaVersion: 2 }) })
  const spaceId = topic.slice(0, 16)
  t.is((await spaceOf(B, spaceId)).status, 'pending', 'B is pending after joining')

  const granter = await rawPeer(t, { bootstrap, topicHex: topic })
  await withDeadline(granter.waitConnected(), scaled(30000), 'raw granter connection')
  const request = await granter.waitFrame((m) => m.type === 'membership:request' && m.spaceTopic === topic, scaled(20000))
  t.ok(HEX64.test(request.signerKey), 'the join request carries the signer key a grant is sealed to')
  const seal = () => b4a.toString(sealSck(crypto.randomBytes(32), b4a.from(request.signerKey, 'hex')), 'hex')

  granter.send({ type: 'membership:grant', spaceTopic: topic, sckSealed: seal(), creator, granterKey: hex(), epoch: '1' })
  await new Promise((r) => setTimeout(r, scaled(4000)))
  t.is((await spaceOf(B, spaceId)).status, 'pending', 'B did not materialize from the malformed grant')
  t.ok(B.readStderr().includes('malformed epoch'), 'B logged the refusal')

  const granted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 20000)
  granter.send({ type: 'membership:grant', spaceTopic: topic, sckSealed: seal(), creator, granterKey: hex() })
  await granted

  const space = await spaceOf(B, spaceId)
  t.is(space.status, 'approved', 'the grant without an epoch was accepted')
  t.is(space.epoch, 0, 'and stored at epoch 0')
})
