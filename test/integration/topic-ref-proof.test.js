import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { receiveFrame, resetFrameIntake } from '../../src/shared/network/frame-intake.js'
import { spaceTopics, socketMsgHandlers, resetRegistries } from '../../src/shared/network/swarm-registries.js'
import { hasProvenSpace } from '../../src/shared/network/topic-refs.js'
import { deriveTopicRef } from '../../src/shared/network/handshake-guard.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { boundSender } from '../helpers/identity-binding.js'
import { scaled } from '../helpers/bare-timing.js'

// What a frame naming one of our spaces by reference earns its socket: the proof that it holds the
// topic, and the identity frame that answers it.

const hex = (n = 32) => b4a.toString(crypto.randomBytes(n), 'hex')
const settle = () => new Promise((r) => setTimeout(r, scaled(300)))

async function heldSpace(t, flags) {
  await freshPeer(t)
  const prev = { ...getRuntimeConfig() }
  setRuntimeConfig({ ...prev, ...flags })
  const { spaceId, topic } = await createSpace('Proof')
  spaceTopics.set(spaceId, topic)
  t.teardown(() => { resetRegistries(); resetFrameIntake(); setRuntimeConfig(prev) })
  return { spaceId, topic }
}

function connFor(noise) {
  const sent = []
  const socket = { publicKey: crypto.keyPair().publicKey, remotePublicKey: noise.publicKey, destroy() {} }
  const msgHandler = { send: (str) => sent.push(JSON.parse(str)) }
  socketMsgHandlers.set(socket, msgHandler)
  const conn = { socket, peerInfo: { publicKey: noise.publicKey, ban() {} }, remoteKey: 'test', msgHandler, noiseHex: b4a.toString(noise.publicKey, 'hex') }
  return { conn, sent }
}

test('with topic refs enforced, a frame the identity gate refuses proves nothing and is not answered', async (t) => {
  const { spaceId, topic } = await heldSpace(t, { topicRefsEnforced: true, handshakeIdentityBindingEnabled: true })
  const sender = boundSender()
  const { conn, sent } = connFor(sender.noise)
  const request = { type: 'membership:request', topicRef: deriveTopicRef(topic, sender.noise.publicKey), displayName: 'x' }

  receiveFrame(conn, JSON.stringify({ ...request, ...sender.fields, sig: hex(64) }))
  await settle()
  t.absent(hasProvenSpace(conn.socket, spaceId), 'an unbound request is no proof')
  t.alike(sent, [], 'and gets no identity frame')

  receiveFrame(conn, JSON.stringify({ ...request, ...sender.fields }))
  await settle()
  t.ok(hasProvenSpace(conn.socket, spaceId), 'the bound request proves the space')
  t.ok(sent.some((f) => f.type === 'handshake' && f.topicRef === deriveTopicRef(topic, conn.socket.publicKey)), 'and is answered with our handshake')
})

test('a burst of space-refs is answered with one identity frame', async (t) => {
  const { topic } = await heldSpace(t, {})
  const noise = crypto.keyPair()
  const { conn, sent } = connFor(noise)
  const probe = JSON.stringify({ type: 'space-ref', topicRef: deriveTopicRef(topic, noise.publicKey) })
  for (let i = 0; i < 5; i++) receiveFrame(conn, probe)
  await settle()
  t.comment(`sent: ${sent.map((f) => f.type).join(', ')}`)
  t.is(sent.filter((f) => f.type === 'handshake').length, 1)
})
