import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import hcrypto from 'hypercore-crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { rawPeer } from '../helpers/raw-peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { waitFor } from '../helpers/poll.js'
import { decodeInvite } from '../../src/shared/contract/invite-envelope.js'
import { signNoiseBinding } from '../../src/shared/network/handshake-guard.js'

// A peer needs nothing but a core key to ask for a core, and Alice's profile key rides every
// handshake she sends. These pin that the key alone buys nothing: her cores replicate only to a
// socket carrying someone she admitted, and stop when that someone leaves.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const bindFlags = () => ({ identityKEK: kekHex() })

async function topicFor(peer, spaceId) {
  return decodeInvite(await peer.request('space:invite', { spaceId })).topic
}

async function mirrorOf(store, keyHex) {
  const core = store.get({ key: b4a.from(keyHex, 'hex') })
  await core.ready()
  return core
}

// A missing block is the assertion's subject, so it is reported, not thrown.
const blockAt = (core, index, ms) => core.get(index, { timeout: scaled(ms) }).catch(() => null)

// A profile core of our own, bound over the raw peer's Noise key, holding the records a member's
// profile bee holds for the space — what the leave handler reads before it applies a departure.
async function memberIdentity(store, noisePublicKey, spaceId) {
  const core = store.get({ name: 'profile' })
  await core.ready()
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.put('caps/membership-manifest', true)
  await bee.put('member/' + spaceId, { active: true, ts: Date.now() })
  return {
    key: b4a.toString(core.key, 'hex'),
    binding: {
      sig: signNoiseBinding(noisePublicKey, core.keyPair.secretKey),
      signerKey: b4a.toString(core.keyPair.publicKey, 'hex'),
      signerNs: b4a.toString(core.manifest.signers[0].namespace, 'hex'),
    },
  }
}

test('REGRESSION (MIR-47: a stranger on the topic replicates none of our cores)', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const { spaceId } = await A.request('space:create', { name: 'Gated' })
  const topic = await topicFor(A, spaceId)

  const store = new Corestore(mkTmpDir(t))
  t.teardown(() => store.close())
  const atk = await rawPeer(t, { bootstrap, topicHex: topic, store })
  const hello = await atk.waitFrame((m) => m.type === 'handshake', scaled(20000))
  const mirror = await mirrorOf(store, hello.profileKey)

  t.is(await blockAt(mirror, 0, 8000), null, 'no block of Alice\'s profile reaches the stranger')
  t.is(mirror.length, 0, 'nor its length')
})

test('REGRESSION (MIR-47: a former member stops replicating our cores when it leaves, and never resumes)', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const { spaceId } = await A.request('space:create', { name: 'Gated' })
  const topic = await topicFor(A, spaceId)

  const store = new Corestore(mkTmpDir(t))
  t.teardown(() => store.close())
  const noise = hcrypto.keyPair()
  const me = await memberIdentity(store, noise.publicKey, spaceId)
  const atk = await rawPeer(t, { bootstrap, topicHex: topic, keyPair: noise, store })
  const hello = await atk.waitFrame((m) => m.type === 'handshake', scaled(20000))
  const handshake = { type: 'handshake', profileKey: me.key, displayName: 'Mallory', spaceTopic: topic, ...me.binding }

  const knocked = A.waitFor('event:member-join-request', (m) => m.publicKey === me.key)
  atk.send({ type: 'membership:request', profileKey: me.key, displayName: 'Mallory', spaceTopic: topic, inviteId: null, ...me.binding })
  await knocked
  await A.request('space:approve-member', { spaceId, publicKey: me.key })
  await atk.waitFrame((m) => m.type === 'membership:grant', scaled(20000))
  const joined = A.waitFor('event:member-joined', (m) => m.member?.publicKey === me.key)
  atk.send(handshake)
  await joined

  const mirror = await mirrorOf(store, hello.profileKey)
  t.ok(await blockAt(mirror, 0, 20000), 'control: an admitted member replicates Alice\'s profile')
  const before = mirror.length
  await A.request('profile:set', { displayName: 'Alice 2' })
  await waitFor(() => mirror.length > before, 20000, { label: 'the admitted mirror follows a new profile block' })
  t.pass('control: it follows her profile as it grows')

  atk.send({ type: 'leave', spaceId, profileKey: me.key, ts: Date.now(), ...me.binding })
  await atk.waitFrame((m) => m.type === 'leave-ack', scaled(20000))
  await waitFor(() => atk.openSockets() === 0, 30000, { label: 'Alice ends the leaver\'s socket' })
  t.pass('the socket that carried only the leaver is closed')
  const atLeave = mirror.length

  await waitFor(() => atk.openSockets() > 0, 60000, { label: 'the former member reconnects' })
  const readmitted = A.waitFor('event:member-joined', (m) => m.member?.publicKey === me.key, 8000)
  atk.send(handshake)
  await t.exception(readmitted, 'the former member\'s handshake is not admitted')

  await A.request('profile:set', { displayName: 'Alice 3' })
  t.is(await blockAt(mirror, atLeave, 8000), null, 'no profile block written after the leave reaches it')
  t.is(mirror.length, atLeave, 'nor does her new length')
})
