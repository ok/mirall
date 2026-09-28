import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { deriveTopicRef } from '../../src/shared/network/handshake-guard.js'
import { topicField, frameSpace, noteLegacyTopic, rememberUnheldTopic, adoptUnheldTopics } from '../../src/shared/network/topic-refs.js'
import { spaceTopics, socketMsgHandlers, resetRegistries } from '../../src/shared/network/swarm-registries.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const hex = () => b4a.toString(crypto.randomBytes(32), 'hex')

// A socket as the swarm hands it over: our Noise key and the remote's.
const socketFrom = (remotePublicKey = crypto.keyPair().publicKey, publicKey = crypto.keyPair().publicKey) => ({ publicKey, remotePublicKey })

function heldSpace(t, spaceId = 's1') {
  const topic = hex()
  spaceTopics.set(spaceId, topic)
  t.teardown(() => resetRegistries())
  return topic
}

test('a topic ref is not the topic, its content-plane topic, or its hypercore discovery key', (t) => {
  const topic = hex()
  const topicBuf = b4a.from(topic, 'hex')
  const noise = crypto.keyPair().publicKey
  const ref = deriveTopicRef(topic, noise)
  t.ok(/^[0-9a-f]{64}$/.test(ref))
  t.is(ref, deriveTopicRef(topic, noise), 'deterministic')
  t.not(ref, topic)
  t.not(ref, b4a.toString(crypto.hash(b4a.concat([topicBuf, b4a.from('mirall/content-plane/v1')])), 'hex'))
  t.not(ref, b4a.toString(crypto.discoveryKey(topicBuf), 'hex'))
})

test('two senders naming one space send different refs', (t) => {
  const topic = hex()
  t.not(deriveTopicRef(topic, crypto.keyPair().publicKey), deriveTopicRef(topic, crypto.keyPair().publicKey))
})

test('a ref names its space only under the key of the sender that derived it', (t) => {
  const topic = heldSpace(t)
  const sender = crypto.keyPair().publicKey
  const ref = deriveTopicRef(topic, sender)
  t.alike(frameSpace({ topicRef: ref }, socketFrom(sender)), { spaceId: 's1', legacy: false })
  t.is(frameSpace({ topicRef: ref }, socketFrom()), null, 'replayed on another connection it names nothing')
  t.is(frameSpace({ topicRef: hex() }, socketFrom(sender)), null)
  t.is(frameSpace({ topicRef: 'zz' }, socketFrom(sender)), null)
  t.is(frameSpace({ topicRef: ref }, { remotePublicKey: null }), null, 'no remote key, no match')
})

test('a bearer topic names its space as legacy; a frame with a ref is matched by the ref alone', (t) => {
  const topic = heldSpace(t)
  const socket = socketFrom()
  t.alike(frameSpace({ spaceTopic: topic }, socket), { spaceId: 's1', legacy: true })
  t.is(frameSpace({ topicRef: hex(), spaceTopic: topic }, socket), null)
  t.is(frameSpace({ spaceTopic: 'short' }, socket), null)
  t.is(frameSpace({}, socket), null)
})

test('frameSpace matches against the candidate topics it is given', (t) => {
  const topic = hex()
  const sender = crypto.keyPair().publicKey
  t.alike(frameSpace({ topicRef: deriveTopicRef(topic, sender) }, socketFrom(sender), new Map([['gone', topic]])), { spaceId: 'gone', legacy: false })
})

test('a socket gets our ref until it names the space by its bearer topic', (t) => {
  const topic = heldSpace(t)
  const socket = socketFrom()
  const ours = socket.publicKey
  t.alike(topicField(socket, 's1'), { topicRef: deriveTopicRef(topic, ours) }, 'derived under our own key on that socket')
  t.ok(noteLegacyTopic(socket, 's1'), 'first bearer-form sighting')
  t.absent(noteLegacyTopic(socket, 's1'), 'noted once')
  t.alike(topicField(socket, 's1'), { spaceTopic: topic })
  const other = socketFrom(undefined, ours)
  t.alike(topicField(other, 's1'), { topicRef: deriveTopicRef(topic, ours) }, 'per socket')
  t.is(topicField(socket, 'unknown'), null)
  t.alike(topicField(other, 'purged', topic), { topicRef: deriveTopicRef(topic, ours) }, 'an explicit topic for a space not in the registry')
  t.is(topicField({}, 's1'), null, 'a socket with no Noise key of ours gets nothing')
})

test('a new swarm key names the same space by a new ref', (t) => {
  heldSpace(t)
  const before = topicField(socketFrom(), 's1')
  const after = topicField(socketFrom(), 's1')
  t.not(before.topicRef, after.topicRef)
})

test('a topic named before we held it is answered in its form once we join', (t) => {
  t.teardown(() => resetRegistries())
  const topic = hex()
  const socket = socketFrom()
  const other = socketFrom()
  socketMsgHandlers.set(socket, {})
  socketMsgHandlers.set(other, {})
  rememberUnheldTopic(socket, { spaceTopic: topic.toUpperCase() })
  rememberUnheldTopic(other, { topicRef: hex(), spaceTopic: topic })
  spaceTopics.set('s1', topic)
  adoptUnheldTopics('s1', topic)
  t.alike(topicField(socket, 's1'), { spaceTopic: topic })
  t.ok('topicRef' in topicField(other, 's1'), 'a frame that carried a ref is not remembered as bearer-form')
})

test('the legacy-wire lever sends and reads only the bearer form', (t) => {
  const topic = heldSpace(t)
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, testLegacyTopicWire: true })
  t.teardown(() => setRuntimeConfig(prev))
  const sender = crypto.keyPair().publicKey
  t.alike(topicField(socketFrom(), 's1'), { spaceTopic: topic })
  t.is(frameSpace({ topicRef: deriveTopicRef(topic, sender) }, socketFrom(sender)), null)
})
