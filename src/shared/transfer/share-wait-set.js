// The member's half of share-wait: the files we are waiting on an owner to finish hashing, keyed by
// transferId, so the owner can show who is waiting. In memory only. One file can be waited on by
// more than one source — the download engine and a mirror of the same share — and the owner is told
// we stopped only when the last source lets go.
//
// How long a source lives is its own rule, so a long hash never drops a real wait:
//   row     backed by a durable pending row and dropped on every path that clears the row, so it
//           never times out.
//   mirror  re-noted by every mirror pass that walks the entry and by every progress frame the
//           owner sends for it; it expires once neither has happened for expireMs.
//   click   a folder download that recorded nothing; it expires the same way.
// A file is re-announced at most once per resendMs. After the owner reconnects, the first frame
// heard from it — proof it has admitted us again — re-announces at once, since an announcement sent
// before that was dropped as unauthenticated. The owner forgets a waiter it stops hearing from, so
// a lost cancel costs a stale waiter, never a stuck one. Pure: the send is injected and returns
// whether the frame reached a channel.
import { transferIdParts } from './transfer-id.js'

export const SHARE_WAIT_SOURCE = Object.freeze({ ROW: 'row', MIRROR: 'mirror', CLICK: 'click' })
const SOURCES = new Set(Object.values(SHARE_WAIT_SOURCE))
const ENGINE_SOURCES = [SHARE_WAIT_SOURCE.ROW, SHARE_WAIT_SOURCE.CLICK]

export const SHARE_WAIT_RESEND_MS = 10000
// Three of the owner's 30 s waiter windows: a mirror pass (30 s poll) can miss one or two re-notes
// without its wait lapsing.
export const SHARE_WAIT_EXPIRE_MS = 90000
// The owner caps its ledger at the same count per peer, so a member never announces more files
// than the owner would keep.
export const SHARE_WAIT_PER_OWNER = 64

export function createShareWaitSet({ send, now = Date.now, resendMs = SHARE_WAIT_RESEND_MS, expireMs = SHARE_WAIT_EXPIRE_MS, perOwner = SHARE_WAIT_PER_OWNER }) {
  const files = new Map()   // transferId → { ownerKey, spaceId, shareId, relPath, sentAt, unconfirmed, sources: Map<source, notedAt> }
  const byOwner = new Map() // ownerKey → Set<transferId>

  const payloadOf = (f, cancel) => ({ spaceId: f.spaceId, shareId: f.shareId, relPath: f.relPath, ...(cancel ? { cancel: true } : {}) })
  const idsOf = (ownerKey) => [...(byOwner.get(ownerKey) ?? [])]

  function drop(transferId) {
    const f = files.get(transferId)
    if (!f) return null
    files.delete(transferId)
    const ids = byOwner.get(f.ownerKey)
    ids?.delete(transferId)
    if (ids?.size === 0) byOwner.delete(f.ownerKey)
    return f
  }

  // True when nothing is waiting on the file any more.
  function lapse(f, t) {
    for (const [source, notedAt] of f.sources) {
      if (source !== SHARE_WAIT_SOURCE.ROW && t - notedAt > expireMs) f.sources.delete(source)
    }
    return f.sources.size === 0
  }

  function prune(ownerKey, t) {
    for (const id of idsOf(ownerKey)) if (lapse(files.get(id), t)) drop(id)
  }

  // An unsent announcement stays due, so the owner's return delivers it at once.
  function announce(f, t, { confirm = false } = {}) {
    const due = f.sentAt == null || t - f.sentAt >= resendMs || (confirm && f.unconfirmed)
    if (!due || !send(f.ownerKey, payloadOf(f, false))) return
    f.sentAt = t
    if (confirm) f.unconfirmed = false
  }

  function wait(ownerKey, transferId, source) {
    const parts = transferIdParts(transferId)
    if (typeof ownerKey !== 'string' || !ownerKey || !parts || !SOURCES.has(source)) return false
    const t = now()
    let f = files.get(transferId)
    if (f && f.ownerKey !== ownerKey) { drop(transferId); f = undefined }
    if (!f) {
      prune(ownerKey, t)
      if ((byOwner.get(ownerKey)?.size ?? 0) >= perOwner) return false
      f = { ownerKey, ...parts, sentAt: null, unconfirmed: false, sources: new Map() }
      files.set(transferId, f)
      if (!byOwner.has(ownerKey)) byOwner.set(ownerKey, new Set())
      byOwner.get(ownerKey).add(transferId)
    }
    f.sources.set(source, t)
    announce(f, t)
    return true
  }

  // The hash is here — our own fetch started, or the owner said it finished. The owner learns the
  // first from the serve itself; only the file's own owner may claim the second.
  function resolve(transferId, ownerKey = null) {
    if (ownerKey != null && files.get(transferId)?.ownerKey !== ownerKey) return
    drop(transferId)
  }

  // A user stop. True when this released a source; the owner hears it once no source is left.
  function cancel(transferId, sources = ENGINE_SOURCES) {
    const f = files.get(transferId)
    if (!f) return false
    let released = false
    for (const source of sources) released = f.sources.delete(source) || released
    if (released && f.sources.size === 0) {
      drop(transferId)
      send(f.ownerKey, payloadOf(f, true))
    }
    return released
  }

  function cancelShare(spaceId, shareId, source) {
    for (const [id, f] of [...files]) {
      if (f.spaceId === spaceId && f.shareId === shareId) cancel(id, [source])
    }
  }

  function resend(ownerKey) {
    const t = now()
    prune(ownerKey, t)
    for (const id of idsOf(ownerKey)) announce(files.get(id), t)
  }

  // A frame from the owner — its progress for `transferId`. It keeps a mirror's wait on that file
  // alive, and it proves the owner knows us again after a reconnect.
  function heardFrom(ownerKey, transferId) {
    const t = now()
    const f = files.get(transferId)
    if (f?.ownerKey === ownerKey && f.sources.has(SHARE_WAIT_SOURCE.MIRROR)) f.sources.set(SHARE_WAIT_SOURCE.MIRROR, t)
    prune(ownerKey, t)
    for (const id of idsOf(ownerKey)) announce(files.get(id), t, { confirm: true })
  }

  // The owner may have restarted and forgotten us: the next announcement is due at once, and one
  // it drops before it has admitted us again is repeated on the first frame heard from it.
  function ownerReconnected(ownerKey) {
    for (const id of idsOf(ownerKey)) {
      const f = files.get(id)
      f.sentAt = null
      f.unconfirmed = true
    }
  }

  // The owner left the space, or we did: nobody is left to tell.
  function forget({ spaceId, ownerKey = null }) {
    for (const [id, f] of [...files]) {
      if (f.spaceId === spaceId && (ownerKey == null || f.ownerKey === ownerKey)) drop(id)
    }
  }

  return {
    wait,
    resolve,
    cancel,
    cancelShare,
    resend,
    heardFrom,
    ownerReconnected,
    forget,
    clear: () => { files.clear(); byOwner.clear() },
  }
}
