import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { openProfileBee, readMembershipRecord, readPeerRequests, readPeerDenials, getLocalPublicKeyHex } from './profile.js'
import { foldMemberSet } from './member-set.js'
import { createDerivedView } from '../state/derived-view.js'
import { getResourceCaps } from '../core/runtime-config.js'
import { SHARE_PREFIX } from '../shares/shares.js'

// Transitive discovery + fold. Walks the approval graph FORWARD from the creator (the
// root of the OR-Set fold — see member-set.js) and self, reading each reachable peer's
// membership record, then folds them into the member set. Crucially it only opens the
// bees of *confirmed members'* approvees — a peer approved by nobody (a Sybil) is never
// fetched — so discovery is bounded by the real member tree, not by what strangers claim.
//
// `readRecord(key) => Promise<{ active, approvals } | null>` is injected so the discovery
// algorithm is unit-testable without a store; the live wiring (createMemberView) passes
// the bee-backed reader. A null record means "unknown / not replicated yet" — the peer
// (and anyone only it approved) stays out until its bee arrives, then a later fold heals.
export async function deriveMemberSet ({ creatorKey, selfKey, readRecord }) {
  const records = new Map()
  const fetched = new Set()

  const fetch = async (k) => {
    if (!k || fetched.has(k)) return false
    fetched.add(k)
    const rec = await readRecord(k)
    if (rec) records.set(k, rec)
    return true
  }

  await fetch(creatorKey)
  await fetch(selfKey)

  for (;;) {
    const members = foldMemberSet(records, creatorKey)
    let grew = false
    for (const m of members) {
      for (const j of records.get(m)?.approvals || []) {
        if (await fetch(j)) grew = true   // pull in this member's approvees
      }
    }
    if (!grew) {
      const approved = new Set()
      const memberTs = new Map()
      // Positive-evidence leave signal: a record we actually READ that says not-a-member (a
      // replicated `del member/<S>`). Never a null/unreplicated peer, never a cascade victim
      // (their record stays active:true) — so the observer can safely revoke on it.
      const inactive = new Set()
      for (const [k, rec] of records) {
        if (rec && rec.active === false) inactive.add(k)
      }
      // The roster deficit: considered but no readable record yet (a replication gap, never
      // positive evidence — disjoint from inactive by construction). The convergence tick
      // keys its re-fold + escalation on this.
      const unread = new Set()
      for (const k of fetched) {
        if (!records.has(k)) unread.add(k)
      }
      for (const m of members) {
        for (const j of records.get(m)?.approvals || []) approved.add(j)
        const ts = records.get(m)?.memberTs
        if (ts != null) memberTs.set(m, ts)
      }
      return { members, considered: fetched, approved, memberTs, inactive, unread }
    }
  }
}

// Order-independent digest of a derived view's membership-relevant output (member +
// approved key-sets, and the request/denied maps keyed by joiner + write-ts). The watcher
// fires on EVERY append to a roster bee, including ones that don't change membership
// (avatar/displayName/drive writes share the same bee); an identical signature means the
// fold produced the same view, so the downstream reconcile + IPC emit can be skipped.
export function viewSignature ({ members, approved, requests, denied, memberTs, inactive, unread }) {
  const keys = (set) => [...(set || [])].sort().join(',')
  const stamped = (map) => [...(map || [])].map(([k, v]) => k + ':' + (typeof v === 'number' ? v : v?.ts ?? 0)).sort().join(',')
  // memberTs is folded in so a rejoin (a strictly-later member/<S> ts, without any member-set change)
  // still re-emits and lets the durable leave-tombstone self-clear via tombstoneActive. inactive is
  // folded in so a leave that changes no other set (a re-observed leave) still reaches the observer.
  // unread is folded in so a deficit that heals without changing any other set still re-emits —
  // otherwise the registry's stored deficit goes stale and the tick escalates a healed space.
  const canon = keys(members) + '|' + keys(approved) + '|' + stamped(requests) + '|' + stamped(denied) + '|' + stamped(memberTs) + '|' + keys(inactive) + '|' + keys(unread)
  return b4a.toString(crypto.hash(b4a.from(canon)), 'hex')
}

// Live member-set view for a space: re-derives whenever any roster peer's bee changes —
// locally OR via replication — and reports the current member set via onMembers. Built on
// createDerivedView (bursts coalesced, folds serialized). Seeds from creator + self; the
// fold discovers the rest transitively and the view watches every bee it reads, so a newly
// approved member's record re-derives the set on its own once it replicates — no gossip.
// Call trackKey(key) to fold in a roster key learned out-of-band.
export function createMemberView ({ spaceId, creatorKey, selfKey, onMembers, onError, onBeeAppend, onFollow }) {
  const self = selfKey ?? getLocalPublicKeyHex()
  const beeFor = (key) => openProfileBee(b4a.from(key, 'hex'))
  const readRecord = (key) => readMembershipRecord(key, spaceId)

  // Active follow: an open live download per roster bee so a co-member's approval AND the joiner's
  // own membership record reach us even when that peer never sends us a frame directly (it reached
  // another member, or is offline). end:-1 is a live range, so it pulls existing blocks, follows
  // future appends, and stays open until fulfilled — giving eventual, transitive convergence (pulled
  // via any connected member). Without it, watch() never fires because nothing downloads the blocks.
  const follows = new Map()
  // Every followed roster bee also carries the peer's share/<space>/* records. onBeeAppend is the
  // level signal that a followed member — INCLUDING a derived-only one we never handshaked —
  // added/removed a share, letting the share list re-derive instead of waiting for an unrelated
  // event. Watch ONLY that peer's share/<space>/ sub-range, not the whole core: an avatar/
  // displayName/membership append shares the same bee but must not trigger a share re-fetch.
  const shareRange = { gte: SHARE_PREFIX + spaceId + '/', lt: SHARE_PREFIX + spaceId + '/\xff' }
  const shareWatchers = new Map()
  let closed = false
  const follow = (key, bee) => {
    if (closed || key === self || follows.has(key)) return
    follows.set(key, null)
    bee.ready().then(() => {
      if (closed) return   // view closed before ready resolved — don't orphan a live download
      follows.set(key, bee.core.download({ start: 0, end: -1 }))
      // The range download alone is not durable: a wedged replication session serves
      // announces but starves ranges. onFollow lets the registry back it with an
      // explicit-get capture while the peer is reachable.
      if (onFollow) { try { onFollow(key) } catch {} }
      if (onBeeAppend && !shareWatchers.has(key)) {
        const watcher = bee.watch(shareRange)
        const loop = (async () => {
          try { for await (const _ of watcher) { try { onBeeAppend(key) } catch {} } } catch {}
        })()
        shareWatchers.set(key, { watcher, loop })
      }
    }).catch(() => {})
  }

  // Skip the reconcile/IPC emit when a fold reproduces the last view byte-for-byte (an
  // append that didn't touch membership). The fold itself still runs and re-reads, so a
  // real change is never missed; only redundant downstream work is dropped.
  let lastSig = null
  const emit = (result) => {
    const sig = viewSignature(result)
    if (sig === lastSig) return
    lastSig = sig
    onMembers(result)
  }

  const view = createDerivedView({
    fold: async () => {
      const result = await deriveMemberSet({ creatorKey, selfKey: self, readRecord })
      // Watch + actively follow every bee we touched so a later change to it (an approval, a leave, a
      // request receipt) re-folds — pulled to us even with no direct connection to its author.
      for (const key of result.considered) {
        if (!view.tracking(key)) {
          const bee = beeFor(key)
          view.track(key, bee)
          follow(key, bee)
        }
      }
      // Pending requests + dismissals authored by CURRENT members (only their bees replicate to
      // us; a pending joiner's own bee is never opened). Union across members, max-ts wins.
      const requests = new Map()
      const denied = new Map()
      await Promise.all([...result.members].map(async (m) => {
        for (const r of await readPeerRequests(m, spaceId)) {
          const prev = requests.get(r.joiner)
          if (!prev || r.ts > prev.ts) requests.set(r.joiner, { displayName: r.displayName, avatar: r.avatar, ts: r.ts })
        }
        for (const d of await readPeerDenials(m, spaceId)) {
          const prev = denied.get(d.joiner)
          if (prev == null || d.ts > prev) denied.set(d.joiner, d.ts)
        }
      }))
      return { ...result, requests, denied }   // { members, considered, approved, requests, denied }
    },
    onChange: emit,   // receives { members, considered, approved, requests, denied }
    onError,
    debounceMs: getResourceCaps().deriveDebounceMs,
  })

  // Fold in a key learned out-of-band that discovery wouldn't reach on its own.
  const trackKey = (key) => {
    if (!key || view.tracking(key)) return
    const bee = beeFor(key)
    view.track(key, bee)
    follow(key, bee)
    view.recompute()
  }

  const close = () => {
    closed = true
    for (const dl of follows.values()) { try { dl?.destroy?.(null) } catch {} }
    follows.clear()
    for (const { watcher } of shareWatchers.values()) { try { watcher.close() } catch {} }
    shareWatchers.clear()
    return view.close()
  }

  if (creatorKey) trackKey(creatorKey)
  if (self && self !== creatorKey) trackKey(self)
  view.recompute()   // initial derive

  return { recompute: view.recompute, trackKey, close }
}
