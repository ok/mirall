// Whether a peer may still receive a hash. A grant is cached per (peer, synthetic path) at request
// time, and every later chunkNeed is checked against that cache, so a request-time decision would
// otherwise be trusted forever. The epoch moves on any membership or space change, which forces one
// re-authorization per (peer, path) — not one per chunk, so the hot path stays a map lookup.
//
// Grants live on `peer.authorizedServe` ('content:<hash>' → { from, epoch }); `from` is the
// requester's profile key, which the serve telemetry reports.

import { contentHashOf, contentPath } from '../content-path.js'

export class ServeGrants {
  // `authorize(peer, from, contentHash, opts)` is the injected gate; `onServeEnd` tells the
  // sender-side indicator a serve ended; `peers` lists the attached peers.
  constructor({ authorize, onServeEnd = null, peers }) {
    this._authorize = authorize
    this._onServeEnd = onServeEnd
    this._peers = peers
    this.epoch = 0
  }

  // The request-time gate. A throw denies, and a deny is silent: it looks the same as "not held".
  async admit(peer, from, contentHash) {
    try { return !!(await this._authorize(peer, from, contentHash)) } catch { return false }
  }

  grant(peer, synthPath, from, epoch) {
    peer.authorizedServe.set(synthPath, { from, epoch })
  }

  holds(peer, synthPath) {
    return peer.authorizedServe.has(synthPath)
  }

  // A grant whose serve never started: no serve-end fires.
  drop(peer, synthPath) {
    peer.authorizedServe.delete(synthPath)
  }

  // Bump on any membership or space change: it invalidates every cached grant without walking them.
  bumpEpoch() {
    this.epoch++
  }

  // Drop the grants a predicate selects — the active half of revocation, for when exactly what to
  // stop serving is known (a space just left). It takes effect mid-stream, since the serve loop
  // re-checks its grant at every boundary. Returns how many were dropped.
  revoke(predicate) {
    let revoked = 0
    for (const peer of this._peers()) {
      for (const [synthPath, grant] of [...peer.authorizedServe]) {
        let match = false
        try { match = predicate({ contentHash: contentHashOf(synthPath), from: grant.from, peer }) } catch { match = false }
        if (!match) continue
        this._revoke(peer, synthPath, grant)
        revoked++
      }
    }
    return revoked
  }

  // The grant stands iff it was authorized in the current epoch or re-authorizes now. A stale grant
  // the gate definitively denies is dropped, so a peer revoked mid-transfer stops receiving bytes.
  // A throw is a transient read failure, not a deny: the peer already passed the gate once, so the
  // serve continues and re-checks on the next chunk.
  async stillAuthorized(peer, synthPath) {
    const grant = peer.authorizedServe.get(synthPath)
    if (!grant) return false
    if (grant.epoch === this.epoch) return true
    const epoch = this.epoch
    let ok
    try { ok = await this._authorize(peer, grant.from, contentHashOf(synthPath), { rateLimit: false }) } catch { return true }
    // The grant can be revoked, or the peer torn down, across that await.
    if (peer.authorizedServe.get(synthPath) !== grant) return false
    if (!ok) { this._revoke(peer, synthPath, grant); return false }
    grant.epoch = epoch
    return true
  }

  // A serve message's requester, read from the grant, never from the message, so a peer can only
  // affect its own ledger row. `from` is null when the peer was never granted the hash.
  fromOf(peer, contentHash) {
    const synthPath = contentPath(contentHash)
    return { synthPath, from: peer.authorizedServe.get(synthPath)?.from ?? null }
  }

  // The peer is gone: every serve it was pulling has ended.
  endAll(peer) {
    if (!this._onServeEnd) return
    for (const [synthPath, grant] of peer.authorizedServe) this._ended(peer, synthPath, grant)
  }

  _revoke(peer, synthPath, grant) {
    peer.authorizedServe.delete(synthPath)
    this._ended(peer, synthPath, grant)
  }

  _ended(peer, synthPath, grant) {
    if (!this._onServeEnd) return
    try { this._onServeEnd({ path: synthPath, peer, from: grant?.from ?? null }) } catch {}
  }
}
