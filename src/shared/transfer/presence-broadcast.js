// Presence and the ephemeral broadcasts that ride the same lane: the liveness heartbeat, the
// departure notice, and the share prepare/index progress frames. All of it is fire-and-forget — no
// durable state, no acknowledgement — which is why it separates from the swarm's connection handling
// so cleanly.
//
// Reads the shared registries directly and takes its three genuine collaborators through init(),
// following the module-state pattern serve-ledger.js and loose-overlay.js already use here. That
// keeps swarm.js's public surface intact: it re-exports these names rather than wrapping them.
import b4a from 'b4a'
import { getProfileKey } from '../spaces/profile.js'
import { LOOSE_SHARE_ID } from './transfer-id.js'
import { shareDecoKey } from './decoration-key.js'
import { peerSeen } from '../audit/network-watch.js'
import { presenceFrameKind } from '../state/presence.js'
import { connectedPeers, socketToPeers, spaceTopics, socketMsgHandlers } from './swarm-registries.js'

let presence = null
let membersPoke = null
let presenceTimer = null
let getSwarm = () => null
let getIpc = () => null

// getSwarm and getIpc are read at call time, not captured: initSwarm and destroySwarm reassign both,
// so a value taken at init would go stale on the first reconnect.
export function initPresenceBroadcast(deps) {
  presence = deps.presence
  membersPoke = deps.membersPoke
  getSwarm = deps.getSwarm
  getIpc = deps.getIpc
}

export function stopPresenceHeartbeat() {
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null }
}

// Heartbeat: advertise our own liveness per space to the peers in it. The recipient leases
// us for PRESENCE_TTL_MS from when it receives this — we can't extend our own lease.
function broadcastPresence() {
  if (socketMsgHandlers.size === 0) return
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  for (const [spaceId, topicHex] of spaceTopics) {
    for (const [, peer] of connectedPeers) {
      if (!peer.spaces.has(spaceId)) continue
      const handler = socketMsgHandlers.get(peer.socket)
      if (handler) { try { handler.send(JSON.stringify({ type: 'presence', profileKey: profileKeyHex, spaceTopic: topicHex })) } catch {} }
    }
  }
}

// Graceful-quit departure: tell every connected peer we're going offline NOW so they flip us
// offline immediately instead of waiting out the socket close / 15s presence TTL. Reuses the
// presence frame with offline:true (NOT the leave frame — that mints membership tombstones we must
// not trigger on a mere quit). Best-effort; socket close + TTL remain the backstops.
export function broadcastDeparture() {
  // Stop our own heartbeat first: a heartbeat firing later in the shutdown teardown window would
  // re-mark us online on a receiver (mark after clear) and undo this departure.
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null }
  if (!getSwarm() || socketMsgHandlers.size === 0) return
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  for (const [spaceId, topicHex] of spaceTopics) {
    for (const [, peer] of connectedPeers) {
      if (!peer.spaces.has(spaceId)) continue
      const handler = socketMsgHandlers.get(peer.socket)
      if (handler) { try { handler.send(JSON.stringify({ type: 'presence', profileKey: profileKeyHex, spaceTopic: topicHex, offline: true })) } catch {} }
    }
  }
}

// Owner→members: live indexing/hashing progress for a file still advertised with contentHash:null
// (consumer status 'preparing'). Ephemeral, scoped to peers connected on this space.
export function broadcastSharePrepareProgress(spaceId, payload) {
  if (socketMsgHandlers.size === 0) return
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  const frame = JSON.stringify({ type: 'share-prepare-progress', profileKey: profileKeyHex, spaceId, ...payload })
  for (const [, peer] of connectedPeers) {
    if (!peer.spaces.has(spaceId)) continue
    const handler = socketMsgHandlers.get(peer.socket)
    if (handler) { try { handler.send(frame) } catch {} }
  }
}

// A share is admission-gated at 5k files and a folder that grows past it keeps publishing, so this
// is a display bound, not a limit — it only stops a peer-supplied count from rendering as nonsense.
const MAX_WIRE_COUNT = 1_000_000

// Owner→members: how much of a share is still waiting to be indexed. Ephemeral like the per-file
// frame above, and for the same reason — the queue is not durable state, so it is re-announced
// rather than replicated. It carries what the catalog cannot: files that have no entry yet because
// their publish has not started.
export function broadcastShareIndexProgress(spaceId, payload) {
  if (socketMsgHandlers.size === 0) return
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  const frame = JSON.stringify({ type: 'share-index-progress', profileKey: profileKeyHex, spaceId, ...payload })
  for (const [, peer] of connectedPeers) {
    if (!peer.spaces.has(spaceId)) continue
    const handler = socketMsgHandlers.get(peer.socket)
    if (handler) { try { handler.send(frame) } catch {} }
  }
}

// Re-surface an owner's queue depth to our renderer. Same anti-spoof guard as the prepare frame:
// accept only from an identity authenticated on this socket. Non-authoritative and count-only —
// it names no file and gates no content, so the worst a bad frame can do is a wrong number in a
// notice. Its own validator: the prepare frame's requires total > 0 and bytes within it, which a
// queue summary does not satisfy.
function handleShareIndexProgressFrame(socket, msg) {
  const { profileKey, spaceId, shareId, adding, bytesQueued } = msg
  if (typeof profileKey !== 'string' || typeof spaceId !== 'string' || typeof shareId !== 'string') return
  if (!socketToPeers.get(socket)?.has(profileKey)) return
  // The sender is carried through as `ownerKey` so the consumer can require it to be the share's
  // actual owner. Authentication proves only WHO is speaking: without this any approved co-member
  // could describe someone else's share, and the notice names that someone by display name.
  // Wire numbers are peer-controlled: whole counts only, bounded, so a bad frame cannot reach the
  // renderer as a fractional or astronomically pluralized sentence.
  const safeCount = (n) => (Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_WIRE_COUNT) : 0)
  const safeBytes = (n) => (Number.isFinite(n) && n > 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 0)
  getIpc().emit('event:share-index-progress', {
    spaceId, shareId, ownerKey: profileKey, adding: safeCount(adding), bytesQueued: safeBytes(bytesQueued),
  })
}

// Receive a peer's heartbeat: refresh its lease, but only for an identity already
// authenticated on this socket (same guard as the leave frame) — so presence can't be
// spoofed for a peer we never handshaked. The TTL is ours; any sender-claimed expiry is
// ignored.
function handlePresenceFrame(socket, msg) {
  const kind = presenceFrameKind(msg)
  if (kind === 'ignore') return
  const { profileKey, spaceTopic } = msg
  if (!socketToPeers.get(socket)?.has(profileKey)) return
  const spaceId = resolveSpaceIdForTopic(spaceTopic)
  if (!spaceId) return
  if (kind === 'clear') {
    // Explicit graceful-quit departure (offline:true): flip the peer offline now, don't wait for
    // the socket close or the TTL. Gate the emit on a real online→offline transition (like the mark
    // path) so repeated departure frames can't amplify reconcile hints. Idempotent with the
    // socket-close handleDisconnect that follows.
    if (presence.clear(profileKey, spaceId)) {
      membersPoke.poke(spaceId)
      getIpc()?.emit('event:files-updated', { spaceId })
    }
    return
  }
  if (presence.mark(profileKey, spaceId)) {
    // Same-socket lease restore: the peer went silent past the TTL and is back without
    // a re-handshake — the arrival mirror of the onExpire departure emit.
    peerSeen(profileKey, spaceId)
    membersPoke.poke(spaceId)
    getIpc()?.emit('event:files-updated', { spaceId })
  }
}

// Re-surface a peer's indexing progress to our renderer. Same anti-spoof guard as presence/leave:
// accept only from an identity authenticated on this socket. Non-authoritative — the row shows it
// only while genuinely 'preparing', and contentHash still gates the content itself.
function handleSharePrepareProgressFrame(socket, msg) {
  const { profileKey, spaceId, shareId, relPath, bytes, total, eta } = msg
  if (typeof profileKey !== 'string' || typeof spaceId !== 'string') return
  if (typeof shareId !== 'string' || typeof relPath !== 'string') return
  if (!socketToPeers.get(socket)?.has(profileKey)) return
  const key = shareId === LOOSE_SHARE_ID ? '/' + relPath : shareDecoKey(shareId, relPath)
  // The owner finished (or abandoned) the hash. Decorations are cleared only by this frame, so
  // without it the bar sits at ~100% and repaints stale on the next re-hash of the same path. It
  // carries no numbers to validate, and clears at most a cosmetic bar a progress frame repaints.
  if (msg.done === true) {
    // Phase-scoped: this key is SHARED with our own download of the same file, and a re-publish
    // restarts that download the moment the materialized hash replicates — a `done` landing just
    // after it must not take down a live download bar.
    getIpc().emit('event:decoration', { channel: 'transfer', spaceId, key, phase: 'preparing', done: true })
    return
  }
  // Wire numbers are peer-controlled: drop anything non-finite / out of range so a bad frame
  // can't reach the renderer as a NaN bar (width:'NaN%' / aria-valuenow=NaN).
  if (!Number.isFinite(bytes) || !Number.isFinite(total) || total <= 0 || bytes < 0 || bytes > total) return
  // null/absent = the owner is still warming up its estimate ("Estimating…"); preserve it. Any
  // other value is a peer-controlled number, so clamp non-finite/non-positive to 0.
  const safeEta = eta == null ? null : (Number.isFinite(eta) && eta > 0 ? eta : 0)
  getIpc().emit('event:decoration', { channel: 'transfer', spaceId, key, phase: 'preparing', bytes, total, speed: 0, eta: safeEta })
}

function resolveSpaceIdForTopic(topicHex) {
  for (const [spaceId, topic] of spaceTopics) if (topic === topicHex) return spaceId
  return null
}
