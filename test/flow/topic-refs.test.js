import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { rawPeer } from '../helpers/raw-peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { waitFor } from '../helpers/poll.js'
import { decodeInvite } from '../../src/shared/contract/invite-envelope.js'
import { deriveTopicRef } from '../../src/shared/network/handshake-guard.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const hex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const bindFlags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true })

async function topicOf(peer, spaceId) {
  return decodeInvite(await peer.request('space:invite', { spaceId })).topic
}

test('REGRESSION (MIR-42: a socket that knows one topic receives no other space topic)', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const known = await A.request('space:create', { name: 'Known' })
  const hidden = await A.request('space:create', { name: 'Hidden' })
  const knownTopic = await topicOf(A, known.spaceId)
  const hiddenTopic = await topicOf(A, hidden.spaceId)

  const atk = await rawPeer(t, { bootstrap, topicHex: knownTopic })
  await atk.waitConnected()
  await waitFor(() => atk.frames.filter((m) => m.type === 'handshake').length >= 2, 20000, { label: 'one handshake per space' })
  const carrying = (topic) => atk.frames.filter((m) => JSON.stringify(m).includes(topic))
  t.comment(`received ${atk.frames.length} frame(s): ${atk.frames.map((m) => m.type + (m.spaceTopic ? ' spaceTopic' : '') + (m.topicRef ? ' topicRef' : '')).join(', ')}`)

  t.alike(carrying(hiddenTopic), [], 'no frame carries the hidden space topic')
  t.alike(carrying(knownTopic), [], 'nor the known one, which this socket never sent')
  const ref = (topic) => deriveTopicRef(topic, atk.remotePublicKey())
  t.ok(atk.frames.some((m) => m.topicRef === ref(knownTopic)), 'the known space is named by the sender-bound ref')

  atk.send({ type: 'handshake', profileKey: hex(), displayName: 'Old', spaceTopic: knownTopic })
  await atk.waitFrame((m) => m.type === 'handshake' && m.spaceTopic === knownTopic, scaled(20000))
  t.alike(carrying(hiddenTopic), [], 'answering a bearer-form peer in its form discloses no other topic')
})

test('a peer on the bearer-topic wire and one on refs admit each other both ways', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const fresh = await launchPeer(t, { bootstrap, displayName: 'New', storage: idStore(t), downloads: mkTmpDir(t) })
  // The re-announce tick is off on the old side, so the second leg can only converge through the
  // unheld-topic memory: its handshake for the new space reaches `fresh` before `fresh` holds it.
  const old = await launchPeer(t, { bootstrap, displayName: 'Old', storage: idStore(t), downloads: mkTmpDir(t), flags: { testLegacyTopicWire: true, convergenceTickMs: 0 } })

  const byNew = await connectInSpaceWithApproval(t, fresh, old, 'Created by new')
  const byOld = await connectInSpaceWithApproval(t, old, fresh, 'Created by old')
  t.ok(byNew && byOld, 'both spaces admitted across the wire versions')
})
