// How a peer frame names a space. A frame carries `topicRef` (deriveTopicRef under the sender's
// Noise key), never the topic. The bearer topic goes out as `spaceTopic` only to a socket that named
// that space by its topic first — a peer on a release that cannot read a reference — and both forms
// are accepted. The receiver matches either against the topics it holds. With topic refs enforced
// the bearer form names nothing, and a socket that has not named a space yet is sent only its ref.
//
// Everything here is per socket and held in WeakMaps: the Noise keys refs are derived under are the
// socket's own, so the state goes when the socket does and a swarm restart starts from nothing.
import { isLegacyTopicWireForced, isTopicRefsEnforced } from '../core/runtime-config.js'
import { deriveTopicRef, isHex64 } from './handshake-guard.js'
import { spaceTopics, socketMsgHandlers } from './swarm-registries.js'

// An honest older peer names each of its spaces once per announce; the cap only bounds what a
// flooding socket can make us hold.
const UNHELD_TOPICS_PER_SOCKET = 256

const ownRefs = new WeakMap()      // socket → Map<spaceId, our ref under socket.publicKey>
const remoteRefs = new WeakMap()   // socket → Map<spaceId, the remote's ref under socket.remotePublicKey>
const bearerSockets = new WeakMap()   // socket → Set<spaceId> it named by the bearer topic
const unheldTopics = new WeakMap()    // socket → Set<topic> it named before we held it
const provenSpaces = new WeakMap()    // socket → Set<spaceId> it named in a form we matched

function memoRef(memo, socket, noiseKey, spaceId, topicHex) {
  let refs = memo.get(socket)
  if (!refs) memo.set(socket, (refs = new Map()))
  let ref = refs.get(spaceId)
  if (!ref) refs.set(spaceId, (ref = deriveTopicRef(topicHex, noiseKey)))
  return ref
}

/**
 * The field that names spaceId on a frame sent over socket; null when we hold no topic for it.
 * @param {{ publicKey?: Uint8Array | null }} socket
 * @param {string} spaceId
 * @param {string} [topicHex]
 * @returns {{ topicRef: string } | { spaceTopic: string } | null}
 */
export function topicField(socket, spaceId, topicHex = spaceTopics.get(spaceId)) {
  if (!topicHex) return null
  if (isLegacyTopicWireForced() || bearerSockets.get(socket)?.has(spaceId)) return { spaceTopic: topicHex }
  if (!socket.publicKey) return null
  return { topicRef: memoRef(ownRefs, socket, socket.publicKey, spaceId, topicHex) }
}

/**
 * The space a frame received on socket names among `topics`, and whether it named it by the bearer
 * topic. A frame carrying a topicRef is matched by the ref alone.
 * @param {{ topicRef?: string, spaceTopic?: string }} msg
 * @param {{ remotePublicKey?: Uint8Array | null }} socket
 * @param {Iterable<[string, string]>} [topics]
 * @returns {{ spaceId: string, legacy: boolean } | null}
 */
export function frameSpace(msg, socket, topics = spaceTopics) {
  if (typeof msg.topicRef === 'string' && !isLegacyTopicWireForced()) {
    const remoteKey = socket.remotePublicKey
    if (!remoteKey || !isHex64(msg.topicRef)) return null
    for (const [spaceId, topicHex] of topics) {
      if (memoRef(remoteRefs, socket, remoteKey, spaceId, topicHex) === msg.topicRef) return { spaceId, legacy: false }
    }
    return null
  }
  if (isTopicRefsEnforced() || !isHex64(msg.spaceTopic)) return null
  for (const [spaceId, topicHex] of topics) if (topicHex === msg.spaceTopic) return { spaceId, legacy: true }
  return null
}

/**
 * True the first time socket names spaceId by its bearer topic.
 * @param {object} socket
 * @param {string} spaceId
 */
export function noteLegacyTopic(socket, spaceId) {
  if (isTopicRefsEnforced()) return false
  let spaces = bearerSockets.get(socket)
  if (!spaces) bearerSockets.set(socket, (spaces = new Set()))
  if (spaces.has(spaceId)) return false
  spaces.add(spaceId)
  return true
}

// A bearer topic we do not hold yet. Joining it later must answer this socket in the same form, or
// an older peer that announced before we joined never reads our first frame for the space.
export function rememberUnheldTopic(socket, msg) {
  if (isTopicRefsEnforced() || typeof msg.topicRef === 'string' || !isHex64(msg.spaceTopic)) return
  let topics = unheldTopics.get(socket)
  if (!topics) unheldTopics.set(socket, (topics = new Set()))
  if (topics.size >= UNHELD_TOPICS_PER_SOCKET) topics.delete(topics.values().next().value)
  topics.add(msg.spaceTopic.toLowerCase())
}

export function adoptUnheldTopics(spaceId, topicHex) {
  const topic = topicHex.toLowerCase()
  for (const socket of socketMsgHandlers.keys()) {
    if (unheldTopics.get(socket)?.delete(topic)) noteLegacyTopic(socket, spaceId)
  }
}

// A socket proves a space by naming it in a form only a holder of the topic can produce. True the
// first time socket proves spaceId.
export function noteSpaceProven(socket, spaceId) {
  let spaces = provenSpaces.get(socket)
  if (!spaces) provenSpaces.set(socket, (spaces = new Set()))
  if (spaces.has(spaceId)) return false
  spaces.add(spaceId)
  return true
}

export function hasProvenSpace(socket, spaceId) {
  return provenSpaces.get(socket)?.has(spaceId) ?? false
}
