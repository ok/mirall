// Durable leave state in the `spaces-meta` bee — the `leaving` marker, the `left/` tombstones
// and the `pendingleave/` markers (key layout: see space.js) — plus the record deletions and
// the boot pass that finishes an interrupted leave. The step ORDER a leave runs in is
// membership/leave-state.js; this module owns what survives a crash between those steps.
import { clearOwnMembership } from './profile.js'
import { listOwnedMounts, deleteOwnedMount, listForeignMounts, deleteForeignMount } from '../folders/mount-store.js'
import { readOwnShares, tombstoneShare } from '../shares/shares.js'
import { runLeaveTeardown } from './membership/leave-state.js'
import { getStore } from '../core/store.js'
import { prefixRange } from '../core/bee-keys.js'
import { createLogger } from '../core/logger.js'
import { spacesMeta, mutateSpace, deleteSpaceRecord } from './space.js'
import { dropDrive } from './space-drives.js'

const log = createLogger('leave-records')

// Durable, LOCAL-only leave tombstones: we observed a peer leave, so the member-view fold keeps
// subtracting it after a restart (including the creator/root, where revokeApproval cannot help).
// Never replicated, so it only ever suppresses the leaver in OUR OWN fold — no cross-peer eviction.
// Stamped with the leaver's clock so a genuine rejoin (a strictly-later member/<S> ts) self-clears
// it via tombstoneActive.
const LEFT_TOMBSTONE_PREFIX = 'left/'
const leftRange = (spaceId) => prefixRange(LEFT_TOMBSTONE_PREFIX + spaceId + '/')
// Coerced to a positive finite number: a negative reaching the tombstoneActive comparison would
// flip it false and re-admit the leaver, so on-disk garbage collapses to an inert 0.
const sanitizeLeaveTs = (v) => (Number.isFinite(v) && v > 0 ? v : 0)

// One ~1-record tombstone per lifetime departure, cleared on the leaver's rejoin (dropTombstone) and
// on space deletion (clearAllLeftTombstones). Not count-pruned: a tombstone is load-bearing exactly
// when its del has not replicated, and a long-gone unreachable leaver is the likeliest to be
// un-replicated, so "evict the oldest" is the unsafe choice.
export async function persistLeftTombstone(spaceId, key, leaveTs) {
  await spacesMeta().put(LEFT_TOMBSTONE_PREFIX + spaceId + '/' + key, { leaveTs: sanitizeLeaveTs(leaveTs) })
}

// Non-throwing by contract (the caller ignores the result). A del that fails leaves the durable
// tombstone to re-seed the fold at the next boot, so it must not be silent.
export async function clearLeftTombstone(spaceId, key) {
  try { await spacesMeta().del(LEFT_TOMBSTONE_PREFIX + spaceId + '/' + key) } catch (err) {
    log.warn('could not clear a leave tombstone — the member stays suppressed after the next restart:', spaceId, key.slice(0, 12) + '...', '-', err.message)
  }
}

export async function loadLeftTombstones(spaceId) {
  const out = new Map()
  for await (const entry of spacesMeta().createReadStream(leftRange(spaceId))) {
    out.set(entry.key.slice((LEFT_TOMBSTONE_PREFIX + spaceId + '/').length), sanitizeLeaveTs(entry.value?.leaveTs))
  }
  return out
}

async function clearAllLeftTombstones(spaceId) {
  const keys = []
  for await (const entry of spacesMeta().createReadStream(leftRange(spaceId))) keys.push(entry.key)
  for (const k of keys) {
    try { await spacesMeta().del(k) } catch (err) {
      log.warn('could not clear a leave tombstone during rejoin:', k, '-', err.message)
    }
  }
}

// A leave broadcast that provably reached no member (nobody connected, or no ack)
// leaves the departure known only to the leaver's now-offline bee — co-members keep a
// ghost member forever. The marker survives the space-record purge (own key prefix in
// spaces-meta); the swarm re-announces the leave on new connections and boot re-joins
// the topic, until one co-member acks the durable apply and the marker clears.
const PENDING_LEAVE_PREFIX = 'pendingleave/'

export async function persistPendingLeave(spaceId, topic, ts) {
  await spacesMeta().put(PENDING_LEAVE_PREFIX + spaceId, { topic, ts })
}

// Non-throwing by contract. A del that fails means the leave is re-announced at the next boot,
// which is harmless but must not be invisible.
export async function clearPendingLeave(spaceId) {
  try { await spacesMeta().del(PENDING_LEAVE_PREFIX + spaceId) } catch (err) {
    log.warn('could not clear the pending-leave marker — the leave is re-announced at the next boot:', spaceId, '-', err.message)
  }
}

export async function listPendingLeaves() {
  const out = []
  for await (const entry of spacesMeta().createReadStream(prefixRange(PENDING_LEAVE_PREFIX))) {
    out.push({
      spaceId: entry.key.slice(PENDING_LEAVE_PREFIX.length),
      topic: entry.value?.topic || null,
      ts: entry.value?.ts || 0,
    })
  }
  return out
}

// Durable "leave in progress" marker, set as the FIRST durable step of space:leave — before
// clearOwnMembership. A quit anywhere in the teardown then leaves a record boot can finish,
// instead of markOwnMembership re-asserting active:true and resurrecting the space. A clean
// leave deletes the whole record (forgetSpaceRecord), so the marker only ever outlives a crash.
// A separate boolean, not a `status` value, so no existing status branch changes.
export function markSpaceLeavingDurable(spaceId) {
  return mutateSpace(spaceId, (space) => (space.leaving ? null : { ...space, leaving: true }))
}

// Delete only the catalog record, keeping the drive in the in-memory map so a
// subsequent purgeSpaceDrive can still free its on-disk cores. Used early in leave
// so the space disappears durably even if a later purge step fails — a partial
// teardown then leaves reclaimable orphan cores, not a space stuck in the list.
export async function forgetSpaceRecord(spaceId) {
  await clearAllLeftTombstones(spaceId)
  await deleteSpaceRecord(spaceId)
}

// The end of a leave: the record is gone, the drive is no longer live, and the store is flushed
// so the deletion survives a quit that follows immediately.
export async function purgeSpace(spaceId) {
  await forgetSpaceRecord(spaceId)
  dropDrive(spaceId)
  try { await getStore().storage.db.flush() } catch (err) {
    log.warn('flush after purgeSpace failed:', err.message)
  }
}

// Idempotently finish a leave a prior process interrupted: re-assert the durable departure
// (covers a crash BEFORE the member del), drop the space's mount records + own share ads (the
// boot restart loops iterate the MOUNT stores, so a surviving record would re-arm a watcher or
// mirror against the space this pass is about to forget), then delete the local record. Reclaim
// of leftover cores/partials is left to the orphan/leftover sweeps, matching the teardown's own
// "record dropped up front, leftovers reclaimable" contract. Only the member del is a hard gate
// (a throw keeps the marker so the next boot retries it — co-member convergence depends on it);
// the mount/share steps are best-effort so one bad record can't strand the others or the forget.
export async function resumeInterruptedLeave(spaceId) {
  await runLeaveTeardown(spaceId, {
    clearMembership: () => clearOwnMembership(spaceId),
    ownedMounts: async () => {
      for (const m of (await listOwnedMounts()).filter((x) => x.spaceId === spaceId)) {
        await deleteOwnedMount(spaceId, m.shareId)
      }
    },
    shares: async () => {
      for (const s of await readOwnShares(spaceId)) await tombstoneShare(spaceId, s.id)
    },
    foreignMounts: async () => {
      for (const m of (await listForeignMounts()).filter((x) => x.spaceId === spaceId)) {
        await deleteForeignMount(spaceId, m.shareId)
      }
    },
    forget: () => forgetSpaceRecord(spaceId),
  }, { log })
}
