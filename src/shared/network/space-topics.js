// Joining and leaving a space's Hyperswarm topic, and evicting that space's peers when we leave it.
import b4a from 'b4a'
import { getSpace } from '../spaces/space.js'
import { compactStore } from '../storage/compaction.js'
import { createLogger } from '../core/logger.js'
import { joinContentTopic, leaveContentTopic, destroyContentPeerSockets, refreshContentDiscoveries } from './content-swarm.js'
import { noteAnnounced } from './connectivity.js'
import { scheduleStatusEmit } from './network-status.js'
import { forgetSpaceConvergence } from './convergence-tick.js'
import { sendSingleHandshake } from './identity-frames.js'
import { forgetPeer } from './handshake-apply.js'
import { connectedPeers, spaceTopics, spaceDiscoveries, socketMsgHandlers, detachPeerFromSpace } from './swarm-registries.js'

const log = createLogger('space-topics')

const RECONNECT_THROTTLE_MS = 5000

let getSwarm = () => null
let lastReconnectAt = 0

export function initSpaceTopics(deps) {
  getSwarm = deps.getSwarm
}

export async function joinSpaceTopic(spaceId) {
  const space = await getSpace(spaceId)
  if (!space) return
  const topicHex = space.topic
  const topic = b4a.from(topicHex, 'hex')

  spaceTopics.set(spaceId, topicHex)
  log.info('joining topic for space', spaceId, '(' + topicHex.slice(0, 16) + '...)')

  const discovery = getSwarm().join(topic, { server: true, client: true })
  spaceDiscoveries.set(spaceId, discovery)
  joinContentTopic(spaceId, topicHex) // no-op unless the content plane is active
  discovery.flushed().then(
    () => {
      noteAnnounced()
      log.info('topic flushed — discoverable:', spaceId)
    },
    (err) => log.error('topic flush error:', spaceId, err.message)
  )
  scheduleStatusEmit()

  // Hyperswarm reuses existing sockets, so no connection event fires for them: handshake the new
  // space to every already-connected peer explicitly.
  if (socketMsgHandlers.size > 0) {
    log.info('sending new space handshake to', socketMsgHandlers.size, 'existing connections')
    for (const [sock, handler] of socketMsgHandlers) {
      sendSingleHandshake(sock, handler, spaceId, topicHex)
    }
  }
}

export async function leaveSpaceTopic(spaceId) {
  const space = await getSpace(spaceId)
  if (!space) return
  const topic = b4a.from(space.topic, 'hex')
  await getSwarm().leave(topic)
  spaceTopics.delete(spaceId)
  spaceDiscoveries.delete(spaceId)
  try { await leaveContentTopic(spaceId) } catch {} // no-op unless the content plane is active
  // The announce ledger self-prunes the left space on its next drain (status resolves null →
  // settled); the tick's per-space escalation state has to be dropped explicitly.
  forgetSpaceConvergence(spaceId)
  log.info('left topic for space', spaceId)
  scheduleStatusEmit()
}

export async function reconnectAll() {
  const now = Date.now()
  if (now - lastReconnectAt < RECONNECT_THROTTLE_MS) return { ok: false, throttled: true }
  lastReconnectAt = now
  log.info('reconnect requested for', spaceDiscoveries.size, 'topics')
  for (const [spaceId, discovery] of spaceDiscoveries) {
    try {
      await discovery.refresh({ client: true, server: true })
      log.debug('refreshed discovery for', spaceId)
    } catch (err) {
      log.warn('refresh failed for', spaceId, err.message)
    }
  }
  try { await refreshContentDiscoveries() } catch {} // no-op unless the content plane is active
  scheduleStatusEmit()
  return { ok: true }
}

// Detach every connected peer from this space; a peer left in no spaces has its socket dropped.
function disconnectPeersFromSpace(spaceId) {
  for (const [key, peer] of connectedPeers) {
    if (!peer.spaces.has(spaceId)) continue
    if (!detachPeerFromSpace(peer, spaceId)) continue
    try { peer.socket.destroy() } catch {}
    // The overlay content channel rides the CONTENT socket, not this one. Dropping only the
    // control socket leaves the bulk plane serving a space we have just left.
    try { destroyContentPeerSockets(key) } catch {}
    // The close handler that follows finds this key already gone from connectedPeers and skips the
    // rest of its per-peer teardown, so finish it here.
    forgetPeer(key)
  }
}

// Disconnect every member from this space. Overlay copies no bytes into a peer drive, so
// there is no per-member blob cache to purge here — leftover peer cores (written by older
// releases that cached file bytes per peer) are reclaimed by forgetUnreferencedPeerCores
// during leave. The progress contract (one cleaningPeer per member, then compactingPeerCache
// + a compaction) is kept so the leave UI step accounting stays correct.
export async function cleanupSpaceDrives(spaceId, members, onProgress, { compact = true } = {}) {
  const emit = (phase, data) => { if (onProgress) onProgress(phase, data) }

  disconnectPeersFromSpace(spaceId)
  const list = members || []
  for (const member of list) emit('cleaningPeer', { peerName: member.displayName })

  if (list.length > 0) {
    emit('compactingPeerCache')
    if (compact) await compactStore()
  }
}
