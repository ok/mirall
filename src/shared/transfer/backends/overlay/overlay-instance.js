// The single, process-global HyperOverlayV2 instance. Content addressing is
// global by hash, so ONE instance (not per-space) avoids per-space core blow-up;
// it gets its own stable Corestore namespace. This module owns the instance
// lifecycle (init/attach/teardown) and THE SERVE GATE (authorizeServe), wired
// from the socket-auth, membership, and rate-limit helpers (see
// .claude/solution-architecture.md, "Serve authorization").
import { HyperOverlayV2 } from './vendor/overlay-v2.js'
import { serveIndex } from './overlay-serve-index.js'
import { makeServeAuthorizer } from './overlay-authorize.js'
import { onServeStart as ledgerServeStart, onChunkServed as ledgerChunkServed, onServeEnd as ledgerServeEnd, onServeControl as ledgerServeControl, onServeBaseline as ledgerServeBaseline } from './overlay-backend.js'
import { getStore, getStoragePath, hasMasterSecret, overlayIndexEncryptionKey } from '../../../core/store.js'
import { PARTIAL_SUFFIX } from '../../partial-suffix.js'
import path from 'bare-path'
import b4a from 'b4a'
import { getLocalPublicKeyHex } from '../../../spaces/profile.js'
import { senderAuthorizedOnSocket, isApprovedMember } from '../../swarm.js'
import { contentSenderAuthorizedOnSocket } from '../../content-swarm.js'
import { createRateLimiter } from '../../handshake-guard.js'
import { getOverlayServeLimit, isSeparateContentPlaneEnabled } from '../../../core/runtime-config.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay')

// Stable across restarts — these are LOCAL-only cores (file-index Hyperbee +
// sync-feed Hypercore). A fixed string means they aren't orphaned each boot.
// The '-e1' generation encrypts those cores at rest under an M-derived key; a
// fresh generation is required because a plaintext core can't be retro-encrypted.
// One-time migrateOverlayIndexToEncrypted copies the legacy generation into it.
const NAMESPACE = 'mirall-overlay'
const NAMESPACE_ENC = 'mirall-overlay-e1'

// Encrypt only when M is available. Insecure/headless mode (no KEK ⇒ no M) stays
// on the plaintext generation with no key — never key a core we can't reopen.
function useEncryptedOverlay() {
  return hasMasterSecret()
}

// Discovery keys of the overlay's live local cores, so the leftover scan treats them
// as wanted. Empty when the overlay isn't up — the classifier's positive file-index
// detection protects them regardless.
export async function getOverlayLocalDiscoveryKeys() {
  const cores = getOverlay()?.localCores() ?? []
  const dks = []
  for (const core of cores) { try { await core.ready(); dks.push(b4a.toString(core.discoveryKey, 'hex')) } catch {} }
  return dks
}

// Logical on-disk size of the overlay index (chunk maps + version marker + sync feed).
export async function getOverlayLocalByteLength() {
  const cores = getOverlay()?.localCores() ?? []
  let bytes = 0
  for (const core of cores) { try { await core.ready(); bytes += core.byteLength } catch {} }
  return bytes
}

let overlay = null
let serveLimiter = null
// overlay protocol peer → swarm socket, captured at attach. The authorizer maps
// a content-request's peer back to the socket the handshake authenticated on.
const peerSocket = new WeakMap()

const CONTENT_PREFIX = 'content:'
function contentHashOf(synthPath) {
  return synthPath && synthPath.startsWith(CONTENT_PREFIX) ? synthPath.slice(CONTENT_PREFIX.length) : synthPath
}

export function getOverlay() {
  return overlay
}

// App-private receive-journal dir (sibling of the Corestore, like identity.enc).
// Resolved on demand so cleanup paths don't depend on the overlay being live.
export function getJournalDir() {
  return path.join(path.dirname(getStoragePath()), 'journals')
}

export async function initOverlay() {
  if (overlay) return overlay
  serveLimiter = createRateLimiter(getOverlayServeLimit())
  // With the content plane on, the overlay channel rides the content connection, so serve
  // authorization keys on that socket's content-hello; otherwise on the control handshake.
  const socketAuthorized = isSeparateContentPlaneEnabled() ? contentSenderAuthorizedOnSocket : senderAuthorizedOnSocket
  const serveAuthorizer = makeServeAuthorizer({
    peerSocket, socketAuthorized, isApprovedMember, serveLimiter, serveIndex,
  })
  const enc = useEncryptedOverlay()
  overlay = new HyperOverlayV2(getStore(), {
    namespace: enc ? NAMESPACE_ENC : NAMESPACE,
    indexEncryptionKey: enc ? overlayIndexEncryptionKey() : null,
    // App-private receive journals (resume snapshots) — sibling of the Corestore,
    // never in the user's downloads folder.
    journalDir: getJournalDir(),
    partialSuffix: PARTIAL_SUFFIX,
    localProfileKey: getLocalPublicKeyHex(), // stamped on outbound content-requests (msg.from)
    serveAuthorizer,                          // gates every inbound content-request
    // Sender-side download indicator: the protocol serves by synthetic path
    // 'content:<hash>'; strip it to the hash the serve ledger resolves to a file.
    onServeStart: ({ from, path, total }) => ledgerServeStart({ from, contentHash: contentHashOf(path), total }),
    onChunkServe: ({ from, path, bytes }) => ledgerChunkServed({ from, contentHash: contentHashOf(path), bytes }),
    onServeEnd: ({ from, path }) => ledgerServeEnd({ from, contentHash: contentHashOf(path) }),
    // pause → relabel; stop → drop. Resume rides a fresh content-request → onServeStart.
    onServeControl: ({ from, path, state }) => ledgerServeControl({ from, contentHash: contentHashOf(path), state }),
    // Resume baseline: the downloader's true on-disk have-bytes raise its ledger row.
    onServeProgress: ({ from, path, have }) => ledgerServeBaseline({ from, contentHash: contentHashOf(path), have }),
  })
  await overlay.ready() // builds protocol/index/sync cores; REQUIRED before attach
  log.info('instance ready')
  return overlay
}

/**
 * Bind this swarm connection to the overlay protocol. Called SYNCHRONOUSLY inside
 * swarm.on('connection') — protomux will not pair a channel opened after the
 * remote's. The overlay channel never serves to an unauthenticated peer because
 * authorizeServe reads `peerSocket` + `socketAuthorized`, both empty until the
 * connection's handshake (mirall/handshake or mirall/content-hello) authenticates
 * the sender on this socket.
 */
export function attachOverlay(mux, socket) {
  if (!overlay) return
  const peer = overlay.attachProtocol(mux) // protocol 'hyper-overlay/v2' on the SAME mux as mirall/handshake
  if (peer) peerSocket.set(peer, socket)
}

// Stop serving the content this space advertises. The serve grant is cached per (peer, hash) at
// request time, so a departure has to revoke it ACTIVELY — un-announcing the topic and dropping
// the control socket leaves the content socket happily streaming the bytes of a space the peer is
// no longer in. Must run BEFORE the catalog purge: it resolves hash → spaces through serveIndex,
// which the purge empties.
//
// `onlyFrom` scopes it to ONE requester, and is required when a peer left a space we are still in:
// without it we would also revoke the grants of every other member still legitimately downloading
// from us. Omit it only when WE are the one leaving — then nobody is entitled to the space's bytes.
export function revokeServesForSpace(spaceId, onlyFrom = null) {
  if (!overlay) return 0
  return overlay.revokeServes(({ contentHash, from }) => {
    if (!contentHash) return false
    if (onlyFrom && from !== onlyFrom) return false
    // Revoke only when the leaving space is the SOLE advertiser of this hash. Content is
    // deduplicated by hash, so the same bytes can be shared by another space we remain in — those
    // grants must survive (the epoch re-auth drops them only for a peer the live gate no longer
    // approves), or a leave would cut off co-members still legitimately pulling the hash elsewhere.
    let advertisedHere = false
    for (const s of serveIndex.spacesFor(contentHash)) {
      if (s !== spaceId) return false
      advertisedHere = true
    }
    return advertisedHere
  })
}

// Any membership mutation (member removed, approval revoked, leave applied) invalidates the
// cached grants: the next chunk request re-runs the real gate instead of trusting a decision
// taken before the change.
export function bumpServeEpoch() {
  overlay?.bumpServeEpoch()
}

export async function teardownOverlay() {
  try {
    await overlay?.close()
  } finally {
    overlay = null
    serveLimiter = null
  }
}
