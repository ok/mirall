// Deferred admission: a joiner who connected before anyone approved them. The handshake cannot admit
// them yet, so their socket is parked in pendingRequesters and this reconciles it later — when an
// approval record replicates in, or when a space is re-entered.
//
// Kept out of swarm.js because it is a retry loop over the registries, not connection handling, and
// because its two in-flight sets are its own: nothing else reads them.
import { getSpace, listSpaces, listJoinRequests, getJoinRequestDriveKey } from '../spaces/space.js'
import { connectedPeers, spaceTopics, socketMsgHandlers, pendingRequesters } from './swarm-registries.js'

// 'spaceId:joinerKey' currently being admitted via reconcile. Exists only to keep a concurrent
// trigger from starting a second identical pass. readmitInflight is declared with its own function
// further down, where the block already had it.
const pendingAdmitInflight = new Set()

let getGates = () => null
let log = null
let handleHandshake = null
let sendSingleHandshake = null
// Read at call time: initSwarm and destroySwarm reassign the handle.
let getIpc = () => null

export function initDeferredAdmission(deps) {
  getGates = deps.getGates
  log = deps.log
  handleHandshake = deps.handleHandshake
  sendSingleHandshake = deps.sendSingleHandshake
  getIpc = deps.getIpc
}

export function resetDeferredAdmission() {
  pendingAdmitInflight.clear()
  readmitInflight.clear()
}

// A peer we recorded as a pending join request may since have been approved by a
// co-member. Re-run the gate; if it now passes, admit them. If we hold their driveKey
// (captured from a post-grant re-handshake) we replay their handshake directly — opening
// their drive, listing them as a member, sending the reciprocal, and clearing the stale
// request via the shared admit path. If we only ever saw their membership:request (no
// drive), we prompt a fresh handshake over the live socket so they re-send with a driveKey
// the gate can then admit for content — rather than bailing and leaving them unadmitted.
export async function reconcilePendingRequester(spaceId, joinerKey) {
  const key = spaceId + ':admit:' + joinerKey
  if (pendingAdmitInflight.has(key)) return
  pendingAdmitInflight.add(key)
  try {
    const space = await getSpace(spaceId)
    if (!space || space.status === 'pending') return
    if ((space.members || []).some((m) => m.publicKey === joinerKey)) return
    if (!(await getGates().isApprovedByPeers(space, joinerKey))) return
    const sock = connectedPeers.get(joinerKey)?.socket || pendingRequesters.get(joinerKey)
    const topic = spaceTopics.get(spaceId)
    if (!sock || !topic) return
    const driveKey = getJoinRequestDriveKey(spaceId, joinerKey)
    if (!driveKey) {
      const handler = socketMsgHandlers.get(sock)
      if (handler) await sendSingleHandshake(sock, handler, spaceId, topic)
      return
    }
    const req = listJoinRequests(spaceId).find((r) => r.publicKey === joinerKey)
    await handleHandshake(sock, null, {
      type: 'handshake',
      profileKey: joinerKey,
      driveKey,
      displayName: req?.displayName || 'Unknown',
      spaceTopic: topic,
    })
  } finally {
    pendingAdmitInflight.delete(key)
  }
}

async function reconcilePendingRequestersForSpace(spaceId) {
  for (const req of listJoinRequests(spaceId)) {
    reconcilePendingRequester(spaceId, req.publicKey).catch((err) => {
      log.warn('pending requester reconcile failed:', err.message)
    })
  }
}

export async function reconcilePendingRequestersForApprover(approverKey) {
  const spaces = await listSpaces()
  for (const space of spaces) {
    if (!(space.members || []).some((m) => m.publicKey === approverKey)) continue
    await reconcilePendingRequestersForSpace(space.spaceId)
  }
}

const readmitInflight = new Set()

// The derived member set just vouched for joinerKey; admit it if we have a live socket but no
// admitted handshake for this space (its handshake raced ahead of the record that admits it, so we
// bounced it to a join request and never sent the reciprocal — leaving a connected member showing as
// Unknown/Offline). Replaying handleHandshake opens its drive, lists it, marks presence, and sends
// the reciprocal. If we never captured its driveKey, send our handshake instead to prompt a fresh
// one. Unlike reconcilePendingRequester this trusts the fold (no isApprovedByPeers re-check), so it
// also admits the creator, who is approved by nobody.
async function admitDerivedMember(spaceId, joinerKey) {
  const sock = connectedPeers.get(joinerKey)?.socket || pendingRequesters.get(joinerKey)
  const topic = spaceTopics.get(spaceId)
  if (!sock || !topic) return
  const driveKey = getJoinRequestDriveKey(spaceId, joinerKey)
  if (!driveKey) {
    const handler = socketMsgHandlers.get(sock)
    if (handler) await sendSingleHandshake(sock, handler, spaceId, topic)
    return
  }
  const req = listJoinRequests(spaceId).find((r) => r.publicKey === joinerKey)
  await handleHandshake(sock, null, {
    type: 'handshake',
    profileKey: joinerKey,
    driveKey,
    displayName: req?.displayName || 'Unknown',
    spaceTopic: topic,
  })
}

export function readmitConnectedMembers(spaceId, keys) {
  for (const key of keys) {
    if (!pendingRequesters.has(key) && !connectedPeers.has(key)) continue
    const guard = spaceId + ':' + key
    if (readmitInflight.has(guard)) continue
    readmitInflight.add(guard)
    admitDerivedMember(spaceId, key)
      .catch((err) => log.warn('readmit on derive failed:', err.message))
      .finally(() => readmitInflight.delete(guard))
  }
}

export function emitSharesUpdated(spaceId) {
  if (getIpc()) getIpc().emit('event:shares-updated', { spaceId })
}

// A peer's profile bee appended (it holds their `share/<space>/*` records), so refresh the
// share list for every space we share with them. Coarse by design — any bee change pokes
// the list — but cheap, and it's the renderer's only signal that a peer added/removed a share.
// We poke the FILE list too: files:list hides a peer's folder-share contents using prefixes read
// from this same profile bee, but the renderer's useFiles refreshes only on event:files-updated
// (the profile-bee append fires shares-updated, not files-updated). Without this a peer's
// newly-shared — or slow-to-replicate — folder would leak its files into the flat loose-file list
// until some unrelated files-updated happened to fire.
export async function emitPeerSharesUpdated(profileKeyHex) {
  if (!getIpc()) return
  for (const space of await listSpaces()) {
    if ((space.members || []).some((m) => m.publicKey === profileKeyHex)) {
      getIpc().emit('event:shares-updated', { spaceId: space.spaceId })
      getIpc().emit('event:files-updated', { spaceId: space.spaceId })
      getIpc().emit('event:mirrors-updated', { spaceId: space.spaceId })
    }
  }
}
