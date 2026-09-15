// What happens to one accepted socket. Corestore replication rides it, the `mirall/handshake` JSON
// channel is opened on it, and a content backend may bind further channels to the same Protomux —
// all before the channel opens, because Protomux will not pair a channel opened after the remote's.
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { getStore, diagnoseStoreCores, isStorageInconsistency } from '../core/store.js'
import { createLogger } from '../core/logger.js'
import { applyNetImpairment } from './net-impair.js'
import { noteConnection } from './connectivity.js'
import { receiveFrame, forgetPeerLimits } from './frame-intake.js'
import { handleDisconnect } from './handshake-apply.js'
import { sendHandshakeMessages } from './identity-frames.js'
import { sendPendingLeaveFrames, sendPendingCancelFrames } from './leave-protocol.js'
import { spaceTopics, socketMsgHandlers } from './swarm-registries.js'

const log = createLogger('peer-connection')

// Lets a content backend bind extra protocol channels on the same mux (overlay's
// hyper-overlay/v2). Null when the separate content plane carries that channel instead.
let getAttachHook = () => null

export function initPeerConnection(deps) {
  getAttachHook = deps.getAttachHook
}

const BENIGN_SOCKET_ERRORS = ['timed out', 'reset by peer', 'Duplicate connection']
function isBenignSocketError(err) {
  const msg = err?.message || ''
  return BENIGN_SOCKET_ERRORS.some(s => msg.includes(s))
}

// A storage-inconsistency replication proof failure destroys the peer's replication stream and
// arrives at the socket 'error' handler naming only the peer, not the core that couldn't produce the
// proof (see isStorageInconsistency in store.js). Dump the open-core inventory once per worker — the
// same broken proof re-fails on every reconnect, and one named snapshot identifies the core.
let corruptionDiagnosed = false

// The per-socket rate-limit bucket is socket lifetime, not handshake state, so it is forgotten by
// whoever owns the socket rather than by the handshake teardown.
function teardownSocket(socket) {
  if (socket.remotePublicKey) forgetPeerLimits(b4a.toString(socket.remotePublicKey, 'hex'))
  handleDisconnect(socket)
}

export function acceptConnection(socket, peerInfo) {
  applyNetImpairment(socket) // TEST-ONLY: no-op unless runtime-config.netImpair is set
  noteConnection()
  const remoteKey = peerInfo.publicKey ? b4a.toString(peerInfo.publicKey, 'hex').slice(0, 16) : 'unknown'
  log.info('connection from', remoteKey + '...')

  if (spaceTopics.size === 0) {
    log.info('no active spaces, ignoring connection from', remoteKey + '...')
    socket.destroy()
    return
  }

  const store = getStore()
  store.replicate(socket)
  log.debug('replicating corestore with', remoteKey + '...')

  const mux = Protomux.from(socket)
  const channel = mux.createChannel({
    protocol: 'mirall/handshake',
    onopen() {
      log.debug('handshake channel open with', remoteKey + '...')
      sendHandshakeMessages(socket, msgHandler)
    },
  })

  // Constant for the life of the connection, so it is derived once rather than per frame.
  const noiseHex = peerInfo?.publicKey ? b4a.toString(peerInfo.publicKey, 'hex') : null
  const msgHandler = channel.addMessage({
    encoding: c.string,
    onmessage(str) { receiveFrame(conn, str) },
  })

  // One live control connection: the socket, who is on the other end, the Noise key they are
  // reached by, and the channel frames go out on. The frame path takes this whole rather than its
  // fields. Declared after the channel because it carries the channel's handler; onmessage above
  // closes over it and cannot run before channel.open() below.
  const conn = { socket, peerInfo, remoteKey, msgHandler, noiseHex }

  // Synchronous + before channel.open(). Overlay's serve gate denies any request until the
  // handshake authenticates the sender on this socket, so binding here (pre-auth) is safe.
  try { getAttachHook()?.(mux, socket) } catch (err) { log.warn('connection attach hook failed:', err.message) }

  channel.open()
  socketMsgHandlers.set(socket, msgHandler)
  // Re-announce any pending outbound leave on the fresh connection: the co-member may be exactly
  // the peer that was offline when we left.
  sendPendingLeaveFrames(socket, msgHandler)
  sendPendingCancelFrames(socket, msgHandler)

  socket.on('close', () => {
    log.info('peer disconnected:', remoteKey + '...')
    socketMsgHandlers.delete(socket)
    teardownSocket(socket)
  })
  socket.on('error', (err) => {
    const level = isBenignSocketError(err) ? 'debug' : 'warn'
    log[level]('peer error:', remoteKey + '...', err.message)
    if (isStorageInconsistency(err) && !corruptionDiagnosed) {
      corruptionDiagnosed = true
      log.error('replication proof failed on a core with an inconsistent on-disk tree —', err.message)
      diagnoseStoreCores('replication proof failure with ' + remoteKey + '...')
    }
    teardownSocket(socket)
  })
}

export function resetPeerConnection() {
  getAttachHook = () => null
  corruptionDiagnosed = false
}
