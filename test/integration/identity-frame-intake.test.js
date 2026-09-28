import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { receiveFrame, resetFrameIntake } from '../../src/shared/network/frame-intake.js'
import { spaceTopics, pendingRequesters, getBoundSignerKey, resetRegistries } from '../../src/shared/network/swarm-registries.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { boundSender } from '../helpers/identity-binding.js'

// The identity gate and the two registries a membership:grant is built from: the signer key it is
// sealed to (boundSignerKeys) and the socket it is sent on (pendingRequesters).

const hex = (n = 32) => b4a.toString(crypto.randomBytes(n), 'hex')

function joinedTopic(t, { enforce }) {
  setRuntimeConfig({ handshakeIdentityBindingEnabled: enforce })
  const topic = hex()
  spaceTopics.set('space-1', topic)
  t.teardown(() => { resetRegistries(); resetFrameIntake(); setRuntimeConfig({}) })
  return topic
}

function connFor(noise) {
  return {
    socket: { destroy() {} },
    peerInfo: { publicKey: noise.publicKey, ban() {} },
    remoteKey: 'test',
    msgHandler: { send() {} },
    noiseHex: b4a.toString(noise.publicKey, 'hex'),
  }
}

const request = (topic, fields) => JSON.stringify({ type: 'membership:request', spaceTopic: topic, displayName: 'x', ...fields })

function spoofOf(profileKey) {
  return { profileKey, signerKey: b4a.toString(crypto.keyPair().publicKey, 'hex'), signerNs: hex(), sig: hex(64) }
}

test("REGRESSION (MIR-54: an unbound request re-keyed and re-routed a pending joiner's grant): with enforcement off, it moves neither the signer key nor the socket", (t) => {
  const topic = joinedTopic(t, { enforce: false })
  const victim = boundSender()
  const victimConn = connFor(victim.noise)
  receiveFrame(victimConn, request(topic, victim.fields))
  t.is(getBoundSignerKey(victim.profileKey), victim.fields.signerKey, 'the verified request bound its signer key')
  t.is(pendingRequesters.get(victim.profileKey), victimConn.socket, 'and registered its socket')

  receiveFrame(connFor(crypto.keyPair()), request(topic, spoofOf(victim.profileKey)))
  t.is(getBoundSignerKey(victim.profileKey), victim.fields.signerKey, "the victim's signer key is unchanged")
  t.is(pendingRequesters.get(victim.profileKey), victimConn.socket, "the grant still routes to the victim's socket")
})

test('with enforcement off, an unbound request binds no signer key, so it can never be granted', (t) => {
  const topic = joinedTopic(t, { enforce: false })
  const key = hex()
  receiveFrame(connFor(crypto.keyPair()), request(topic, spoofOf(key)))
  t.is(getBoundSignerKey(key), null)
})

test('a verified request from the same profile on a new socket moves the requester', (t) => {
  const topic = joinedTopic(t, { enforce: false })
  const first = boundSender()
  receiveFrame(connFor(first.noise), request(topic, first.fields))
  const again = boundSender({ signer: first.signer, namespace: first.namespace })
  const againConn = connFor(again.noise)
  receiveFrame(againConn, request(topic, again.fields))
  t.is(pendingRequesters.get(first.profileKey), againConn.socket, 'a reconnecting joiner is still reachable')
})

test('with enforcement at its default, an unbound request is dropped before any registry', (t) => {
  const topic = joinedTopic(t, { enforce: undefined })
  const key = hex()
  receiveFrame(connFor(crypto.keyPair()), request(topic, spoofOf(key)))
  t.is(getBoundSignerKey(key), null)
  t.absent(pendingRequesters.has(key))
})
