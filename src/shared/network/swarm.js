// The control plane's composition root. It builds the DHT node and the Hyperswarm, wires the
// collaborators that make up the peer-connection layer, and tears all of it down again.
//
// One Hyperswarm topic per space, one Noise socket per peer carrying Corestore replication, the
// `mirall/handshake` JSON channel and the overlay content channel over Protomux. What arrives on a
// socket is peer-connection.js; what an admitted handshake means is handshake-apply.js; what we
// announce is identity-frames.js; topics are space-topics.js.
//
// Nothing here runs at import. Every collaborator is wired in _open and released in _close, so a
// worker that never starts a swarm carries none of this state.
import DHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { getRuntimeConfig, getConnectionCaps, isSeparateContentPlaneEnabled } from '../core/runtime-config.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { clearListDeficits } from '../transfer/list-deficits.js'
import { resetNetworkWatch } from '../audit/network-watch.js'
import { settleCompaction } from '../storage/compaction.js'
import { initPeerProfileWatch, resetPeerProfileWatch } from '../spaces/peer-profile-watch.js'
import { relayIdentityKeyPair } from './relay.js'
import { initRelayInstall, pinRelayIdentity, resetRelayInstall } from './relay-install.js'
import { connectedPeers, resetRegistries } from './swarm-registries.js'
import { resetPresenceLeases, presence } from './presence-leases.js'
import { initFrameIntake, createFrameLimiters, isBannedNoiseKey, getDroppedFrameCounters, resetFrameIntake } from './frame-intake.js'
import { initIdentityFrames, sendSingleHandshake, resetIdentityFrames } from './identity-frames.js'
import { initHandshakeApply, handleHandshake, membersPoke, getAdmissionGates, resetHandshakeApply } from './handshake-apply.js'
import { initPeerConnection, acceptConnection, resetPeerConnection } from './peer-connection.js'
import { initSpaceTopics } from './space-topics.js'
import { initPresenceBroadcast, startPresenceHeartbeat, stopPresenceHeartbeat } from './presence-broadcast.js'
import { initDeferredAdmission, resetDeferredAdmission } from './deferred-admission.js'
import { initLeaveProtocol, resetLeaveProtocol } from './leave-protocol.js'
import { initConvergenceTick, resetConvergenceTick, startConvergenceTick, convergenceHealth, restartConvergenceTick } from './convergence-tick.js'
import { initConnectivity, resetConnectivity, attachSwarmWatchers, noteBooted } from './connectivity.js'
import { scheduleStatusEmit } from './network-status.js'

const log = createLogger('swarm')

let swarm
let ipcRef = null
// Filled from the subsystem's constructor deps in _open, cleared in _close. Read through accessors
// so a collaborator wired once still sees the current value across a restart.
let membershipControlHandler = null
let connectionAttachHook = null
let overlayReconnectHook = null
let stalledOwnersHook = null
let revokeServesForSpaceHook = null

function wireCollaborators() {
  initRelayInstall({ getSwarm: () => swarm, onStatusChange: scheduleStatusEmit })
  initPeerProfileWatch({ getIpc: () => ipcRef, connectedPeers })
  initFrameIntake({ getMembershipControlHandler: () => membershipControlHandler })
  initIdentityFrames({ getSwarm: () => swarm })
  initHandshakeApply({
    getIpc: () => ipcRef,
    onOwnerReconnect: (ownerKey, spaceId) => overlayReconnectHook?.(ownerKey, spaceId),
  })
  initPeerConnection({ getAttachHook: () => connectionAttachHook })
  initSpaceTopics({ getSwarm: () => swarm })
  initPresenceBroadcast({ presence, membersPoke, log, getSwarm: () => swarm, getIpc: () => ipcRef })
  initDeferredAdmission({
    getGates: getAdmissionGates,
    log,
    handleHandshake,
    sendSingleHandshake,
    getIpc: () => ipcRef,
  })
  initLeaveProtocol({
    log,
    getRevokeServesHook: () => revokeServesForSpaceHook,
    getSwarm: () => swarm,
    getIpc: () => ipcRef,
  })
  initConvergenceTick({
    log,
    getStalledOwners: () => stalledOwnersHook,
    getSwarm: () => swarm,
    getIpc: () => ipcRef,
  })
  initConnectivity({ getDroppedFrameCounters, getSwarm: () => swarm, getIpc: () => ipcRef })
}

function buildSwarm(relaySeedHex) {
  // Tests inject a local hyperdht/testnet bootstrap via runtime-config so the
  // swarm stays off the public DHT; unset in production → default bootstrap.
  const dhtBootstrap = getRuntimeConfig().dhtBootstrap
  const caps = getConnectionCaps()
  // The DHT node is built here rather than left to hyperswarm because dht.defaultKeyPair is the
  // relay-facing identity and hyperswarm gives no way to set it: its seed/keyPair options set
  // swarm.keyPair only, and the HyperDHT it constructs gets no keyPair, so defaultKeyPair stays
  // random. Under a private relay that key IS the membership on both sides — the relay socket is
  // opened with a bare dht.connect(relayKey), by relayConnection in hyperdht's connect.js and by
  // Server._relayConnection — so one enrolment covers both roles. Peers are unaffected — they
  // authenticate swarm.keyPair. Ownership is unchanged: hyperswarm.destroy() destroys this.dht
  // whether it built the node or was handed one, so the teardown still reaches it.
  const dht = new DHT({
    ...(dhtBootstrap ? { bootstrap: dhtBootstrap } : {}),
    keyPair: relayIdentityKeyPair(relaySeedHex),
  })
  pinRelayIdentity(relaySeedHex)
  return new Hyperswarm({
    dht,
    maxServerConnections: caps.maxServerConnections || Infinity,
    maxClientConnections: caps.maxClientConnections || Infinity,
    // firewall returns true to REJECT — drop reconnects from a Noise key we evicted for flooding.
    firewall: (remoteKey) => isBannedNoiseKey(b4a.toString(remoteKey, 'hex')),
  })
}

async function destroySwarm() {
  if (!swarm) return
  log.info('destroying swarm...')
  resetConnectivity()
  resetNetworkWatch()
  stopPresenceHeartbeat()
  resetConvergenceTick()
  resetRegistries()
  clearListDeficits()
  resetPresenceLeases()
  resetFrameIntake()
  resetIdentityFrames()
  resetPeerProfileWatch()
  resetHandshakeApply()
  resetPeerConnection()
  resetLeaveProtocol()
  resetDeferredAdmission()
  resetRelayInstall()
  ipcRef = null
  membershipControlHandler = null
  connectionAttachHook = null
  overlayReconnectHook = null
  revokeServesForSpaceHook = null
  stalledOwnersHook = null
  try {
    await swarm.destroy()
  } catch {}
  swarm = undefined
  // A compaction reads cores the durable tier closes right after this. Bounded on its own: it
  // runs under the runtime tier's shared budget, and a full-range compactRange the user just
  // started would otherwise spend the whole budget and skip every subsystem after this one.
  await settleCompaction()
  log.info('swarm destroyed')
}

export class Swarm extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('ipc', 'membershipControl', 'overlayBackend', 'stalledOwners')
  }

  async _open() {
    // Refused before anything is wired: a second instance that re-pointed the collaborators and
    // then threw would leave the running swarm calling the refused instance's hooks.
    if (swarm) throw new Error('swarm: already running')

    ipcRef = this.deps.ipc
    membershipControlHandler = this.deps.membershipControl
    stalledOwnersHook = this.deps.stalledOwners
    // Exclusive with the content plane: when it is on, the overlay channel rides the content
    // socket and the serve gate authorizes against that socket's hello. Binding here as well
    // would land content requests on a socket the gate cannot authenticate.
    if (!isSeparateContentPlaneEnabled()) {
      connectionAttachHook = (mux, socket) => this.deps.overlayBackend.attach(mux, socket)
    }
    overlayReconnectHook = (ownerKey, spaceId) => this.deps.overlayBackend.resumeForOwner(ownerKey, spaceId)
    revokeServesForSpaceHook = (spaceId, profileKey) => this.deps.overlayBackend.revokeServesForSpace(spaceId, profileKey)

    wireCollaborators()
    // Not in require(): a null seed is the normal case — no relay, or an open one.
    swarm = buildSwarm(this.deps.relaySeedHex ?? null)
    // The matched lane's cap follows the topics we joined (read per take, so joins and leaves
    // need no re-plumbing) — see createDualRateLimiter.
    createFrameLimiters()
    noteBooted()
    log.info('initialized')

    // Both are periodic ticks that outlive the call arming them, so they hang off this subsystem's
    // timer set — which the base closes on every ending, including a failed _open that never
    // reaches _close.
    startPresenceHeartbeat(this.timers)
    startConvergenceTick(this.timers)
    attachSwarmWatchers()

    swarm.on('connection', acceptConnection)
  }

  // One unit: the level-triggered re-drive. Everything else the swarm owns is either event-driven
  // (no pass to stall) or already supervised by the subsystem that owns it.
  supervise({ now = Date.now() } = {}) {
    if (this.closed || this.stopping) return []
    return [{ key: 'convergence', label: 'convergence tick', ...convergenceHealth({ now }) }]
  }

  async recover(key) {
    if (this.stopping || key !== 'convergence') return
    restartConvergenceTick()
  }

  async _close() {
    // Before the sockets drop: the overlay's peer teardown fires the serve-end callbacks whose
    // audit rows the durable tier records, and those frames need a live connection.
    this.deps.overlayBackend.detach()
    await destroySwarm()
  }

  get dht() { return swarm?.dht || null }
}
