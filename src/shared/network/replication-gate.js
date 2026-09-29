// Corestore replication on a control socket waits for membership: a socket replicates only once it
// carries a peer admitted to a space we share, or one we exchanged a membership grant with. Hypercore
// has no per-peer serve hook and corestore no per-stream detach, so the gate is per socket, and a
// socket stops replicating only by closing.
//
// Protomux rejects a channel the remote opens before anything is paired for it, and the remote does
// not ask again until its core next turns downloading. So the cores a socket asks for before
// admission are remembered and offered from our side once it is admitted; the remote's own per-core
// pairing answers that open.
import Hypercore from 'hypercore'
import Protomux from 'protomux'
import b4a from 'b4a'
import { createLogger } from '../core/logger.js'
import { mapLimit } from '../core/concurrency.js'
import { socketToPeers } from './swarm-registries.js'

const log = createLogger('replication-gate')

// A peer asks for every core it is downloading when it attaches, across all its spaces, so the bound
// covers a large working set while keeping a stranger from growing the set without limit.
const MAX_EARLY_ASKS = 1024
const OFFERS_IN_FLIGHT = 8
const HEX64 = /^[0-9a-f]{64}$/i

// socket → hex discovery keys asked for before admission. Present only while the socket is gated.
const earlyAsks = new WeakMap()

let currentStore = () => null

export function initReplicationGate(deps) {
  currentStore = deps.getStore
}

export function resetReplicationGate() {
  currentStore = () => null
}

export function gateReplication(socket) {
  const asked = new Set()
  let capped = false
  earlyAsks.set(socket, asked)
  Hypercore.createProtocolStream(socket, {
    ondiscoverykey(discoveryKey) {
      if (asked.size < MAX_EARLY_ASKS) {
        asked.add(b4a.toString(discoveryKey, 'hex'))
      } else if (!capped) {
        capped = true
        log.debug('early asks past the cap are not offered back on admission')
      }
    },
  })
}

/**
 * @param {object} socket
 * @returns {boolean}
 */
export function replicateOn(socket) {
  const asked = earlyAsks.get(socket)
  // Corestore forgets a stream only on its 'close', which a socket already closing has emitted or
  // is about to: attaching it now would leave the stream tracked forever.
  if (!asked || socket.destroying || socket.destroyed) return false
  const store = currentStore()
  if (!store) return false
  earlyAsks.delete(socket)
  try {
    store.replicate(socket)
  } catch (err) {
    log.warn('replication attach failed:', err.message)
    return false
  }
  mapLimit([...asked], OFFERS_IN_FLIGHT, (hex) => offerCore(socket, hex))
    .catch((err) => log.debug('early-ask offer failed:', err.message))
  return true
}

async function offerCore(socket, discoveryKeyHex) {
  const core = await attachCore(socket, { discoveryKey: b4a.from(discoveryKeyHex, 'hex') })
  await core?.close().catch((err) => log.debug('offer session close failed:', err.message))
}

// One peer's own core over that peer's own socket, before the socket replicates anything else: the
// only core this lets the socket read from us is the one its peer wrote. The caller closes the
// returned session; the core stays attached while its channel is open.
/**
 * @param {object} socket
 * @param {string} profileKeyHex
 */
export async function attachPeerCore(socket, profileKeyHex) {
  if (!HEX64.test(profileKeyHex)) return null
  return attachCore(socket, { key: b4a.from(profileKeyHex, 'hex') })
}

// An inactive session, so the core turns downloading only for a reader that wants it and is not
// pushed to every other replicating stream. It attaches to the mux gateReplication gave the socket,
// and only once the session opened: attaching one that failed would destroy the mux.
async function attachCore(socket, opts) {
  const mux = socket.userData
  const store = currentStore()
  if (!store || !Protomux.isProtomux(mux) || socket.destroying || socket.destroyed) return null
  const core = store.get({ ...opts, active: false })
  try {
    await core.ready()
  } catch (err) {
    log.debug('core not attached:', err.message)
    await core.close().catch(() => {})
    return null
  }
  core.replicate(mux)
  return core
}

// Closing is the only way to stop a socket replicating. A parked knock on the same socket is no
// exception: it knocks again on the reconnect, and keeping the socket for it would let a leaver keep
// replicating by knocking.
/** @param {object} socket */
export function closeIfUnadmitted(socket) {
  if (!socketToPeers.has(socket)) socket.destroy()
}
