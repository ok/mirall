// The bulk-content transport plane. A second Hyperswarm with its own Noise identity that shares
// the control swarm's DHT node and carries ONLY the overlay content channel. Bulk file bytes get
// their own Noise-over-UDX stream (independent ordered buffer + congestion window), so a large
// download can no longer head-of-line-block the Corestore replication + mirall/handshake traffic
// on the control plane — the reason a newly shared folder stayed invisible to a downloading peer
// until it paused. Each content connection authenticates independently via a signed
// mirall/content-hello (profileKey bound to this connection's Noise key), reusing the control
// handshake's identity-binding primitive; serving stays gated on space membership, which the
// control plane maintains.
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { getResourceCaps, getHandshakeRateLimit } from '../core/runtime-config.js'
import { getIdentitySigner, getProfileKey } from '../spaces/profile.js'
import { signNoiseBinding, verifyIdentityBinding, createRateLimiter } from './handshake-guard.js'
import { applyNetImpairment } from './net-impair.js'
import { createContentPeerSockets } from './content-peer-sockets.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('content-swarm')

// The content plane joins a topic DERIVED from the space topic so its DHT lookups only find other
// content-plane peers, never the control-plane identity announced on the space topic — otherwise
// each swarm would cross-dial the other's identity and pair no channels.
const CONTENT_TOPIC_LABEL = b4a.from('mirall/content-plane/v1')
function deriveContentTopic(topicHex) {
  return crypto.hash(b4a.concat([b4a.from(topicHex, 'hex'), CONTENT_TOPIC_LABEL]))
}

let contentSwarm = null
const contentSpaceTopics = new Map() // spaceId → derived content topic buffer
const contentDiscoveries = new Map() // spaceId → PeerDiscovery (kept for reconnect refresh)
const contentPeerSockets = createContentPeerSockets() // content socket → Set<profileKey> authenticated on it
const bannedContentKeys = new Set()    // Noise keys evicted for content-hello flooding
let helloLimiter = null
let contentAttachHook = null
let contentResumeHook = null
let contentBinding = null

export function setContentAttachHook(fn) { contentAttachHook = fn }
export function setContentResumeHook(fn) { contentResumeHook = fn }

// Null between worker boot and initContentSwarm, and again after destroyContentSwarm
// has run during shutdown. Callers must tolerate both.
export function getContentSwarm() { return contentSwarm }

export function contentSenderAuthorizedOnSocket(socket, profileKeyHex) {
  return contentPeerSockets.authorized(socket, profileKeyHex)
}

function getContentBinding() {
  if (contentBinding) return contentBinding
  const signer = getIdentitySigner()
  const noiseKey = contentSwarm?.keyPair?.publicKey
  if (!signer || !noiseKey) return null
  contentBinding = {
    sig: signNoiseBinding(noiseKey, signer.secretKey),
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(signer.namespace, 'hex'),
  }
  return contentBinding
}

function sendContentHello(helloMsg) {
  const binding = getContentBinding()
  if (!binding) return
  const profileKey = b4a.toString(getProfileKey(), 'hex')
  try { helloMsg.send(JSON.stringify({ type: 'content-hello', profileKey, ...binding })) } catch {}
}

function onContentConnection(socket, peerInfo) {
  const remoteKeyHex = peerInfo.publicKey ? b4a.toString(peerInfo.publicKey, 'hex') : ''
  const remoteKey = remoteKeyHex.slice(0, 16) || 'unknown'
  if (contentSpaceTopics.size === 0) { socket.destroy(); return }
  applyNetImpairment(socket) // TEST-ONLY: no-op unless runtime-config.netImpair is set
  log.debug('connection', remoteKey + '...', peerInfo.client ? '(we dialed)' : '(they dialed)')
  socket.on('close', () => log.debug('connection closed', remoteKey + '...'))

  const mux = Protomux.from(socket)
  const channel = mux.createChannel({
    protocol: 'mirall/content-hello',
    onopen() { sendContentHello(helloMsg) },
  })
  const helloMsg = channel.addMessage({
    encoding: c.string,
    onmessage(str) {
      // Rate-limit BEFORE the ed25519 verify so a flood can't spend unbounded CPU. A peer sends
      // one content-hello per connection, so a burst is abusive — ban + evict on sustained abuse.
      if (helloLimiter) {
        const verdict = helloLimiter.take(remoteKeyHex)
        if (!verdict.ok) { if (verdict.ban) { bannedContentKeys.add(remoteKeyHex); socket.destroy() } return }
      }
      let msg
      try { msg = JSON.parse(str) } catch { return }
      if (!msg || msg.type !== 'content-hello') return
      // Same verifier as the control handshake: proves the signer manifest-hashes to
      // msg.profileKey AND signed this socket's Noise key, so a replay onto another
      // connection (a different Noise key) fails.
      if (!verifyIdentityBinding(peerInfo, msg)) { log.warn('content-hello rejected from', remoteKey + '...'); return }
      contentPeerSockets.add(socket, msg.profileKey)
      log.debug('content-hello verified from', msg.profileKey.slice(0, 12) + '... — resuming its downloads')
      // The plane can now serve/fetch this owner → resume its paused/interrupted downloads.
      contentResumeHook?.(msg.profileKey)
    },
  })

  // Bind the overlay channel on THIS mux, synchronous + before channel.open() (protomux won't
  // pair a channel opened after the remote's). Serving stays denied until content-hello verifies.
  try { contentAttachHook?.(mux, socket) } catch (err) { log.warn('content attach hook failed:', err.message) }
  channel.open()

  socket.on('close', () => contentPeerSockets.forget(socket))
}

export function initContentSwarm(sharedDht) {
  if (contentSwarm) return contentSwarm
  if (!sharedDht) { log.warn('no shared DHT — content plane not started'); return null }
  const caps = getResourceCaps()
  helloLimiter = createRateLimiter(getHandshakeRateLimit().matched)
  // Distinct identity (fresh keyPair, ephemeral per process like the control swarm) so the remote
  // sees a different key and hyperswarm's per-(swarm, remoteKey) dedup keeps this connection
  // separate from the control one. Share the control swarm's DHT node.
  contentSwarm = new Hyperswarm({
    dht: sharedDht,
    maxServerConnections: caps.serverConnections || Infinity,
    maxClientConnections: caps.clientConnections || Infinity,
    firewall: (remoteKey) => bannedContentKeys.has(b4a.toString(remoteKey, 'hex')),
  })
  contentBinding = null
  contentSwarm.on('connection', onContentConnection)
  log.info('initialized')
  return contentSwarm
}

export function joinContentTopic(spaceId, topicHex) {
  if (!contentSwarm || contentDiscoveries.has(spaceId)) return
  const topic = deriveContentTopic(topicHex)
  contentSpaceTopics.set(spaceId, topic)
  const discovery = contentSwarm.join(topic, { server: true, client: true })
  contentDiscoveries.set(spaceId, discovery)
  discovery.flushed().catch(() => {})
}

export async function leaveContentTopic(spaceId) {
  const topic = contentSpaceTopics.get(spaceId)
  if (!contentSwarm || !topic) return
  try { await contentSwarm.leave(topic) } catch {}
  contentSpaceTopics.delete(spaceId)
  contentDiscoveries.delete(spaceId)
}

// Drop every content socket this peer is authenticated on. The control plane owns the "do we
// still share a space with this peer" decision; this is the content-plane half of the same
// teardown. Without it, leaving a space stops announcing the content topic but leaves the live
// socket serving bulk bytes for the space we just left — hyperswarm's leave() un-announces, it
// does not close established connections. Destroying the socket closes the overlay channel
// riding it, which drops the peer's cached serve grants with it.
export function destroyContentPeerSockets(profileKeyHex) {
  return contentPeerSockets.destroyFor(profileKeyHex)
}

export async function refreshContentDiscoveries() {
  if (!contentSwarm) return
  for (const [, discovery] of contentDiscoveries) {
    try { await discovery.refresh({ client: true, server: true }) } catch {}
  }
}

// Is this owner reachable on the bulk plane at all? A pending download from an owner with no
// content socket is a stalled transfer — swarm.js escalates that into a discovery refresh.
export function contentPlaneHasPeer(profileKeyHex) {
  return contentPeerSockets.hasPeer(profileKeyHex)
}

export function getContentPlaneStatus() {
  if (!contentSwarm) return { active: false, connections: 0, authedPeers: 0, topics: 0 }
  return {
    active: true,
    connections: contentSwarm.connections?.size || 0,
    authedPeers: contentPeerSockets.size,
    topics: contentSpaceTopics.size,
  }
}

export async function destroyContentSwarm() {
  if (!contentSwarm) return
  // We SHARE the control swarm's DHT node; hyperswarm.destroy() would destroy that shared node
  // (via dht.destroy()) and tear the control plane down with us. So leave topics + close our
  // server + drop EVERY connection ourselves (destroy() would have relied on dht.destroy() for
  // that), and let destroySwarm() own the DHT teardown.
  for (const topic of contentSpaceTopics.values()) {
    try { await contentSwarm.leave(topic) } catch {}
  }
  try { await contentSwarm.server?.close?.() } catch {}
  for (const socket of contentSwarm.connections) { try { socket.destroy() } catch {} }
  contentSpaceTopics.clear()
  contentDiscoveries.clear()
  contentPeerSockets.clear()
  bannedContentKeys.clear()
  helloLimiter = null
  contentBinding = null
  contentSwarm = null
  log.info('destroyed')
}
