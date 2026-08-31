import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { getStore } from '../../src/shared/core/store.js'
import { getLocalPublicKeyHex, markOwnMembership, markApproval, readMembershipRecord, markRequest, readPeerRequests } from '../../src/shared/spaces/profile.js'
import {
  persistLeftTombstone, loadLeftTombstones, clearLeftTombstone, forgetSpaceRecord, createSpace,
} from '../../src/shared/spaces/space.js'
import { openMemberView, closeMemberView, isLeft, isMember } from '../../src/shared/spaces/member-registry.js'

const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 25)) }
  return pred()
}
// A standalone peer bee (its own store) replicated into ours, standing in for a remote member.
async function makePeer (t) {
  const dir = path.join(os.tmpdir(), `tomb-peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  const store = new Corestore(dir)
  await store.ready()
  const core = store.get({ name: 'profile' })
  await core.ready()
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.put('caps/membership-manifest', true)
  t.teardown(async () => { try { await store.close() } catch {}; try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return { store, bee, key: b4a.toString(core.key, 'hex') }
}
function replicate (a, b, t) {
  const s1 = a.replicate(true); const s2 = b.replicate(false)
  s1.on('error', () => {}); s2.on('error', () => {}); s1.pipe(s2).pipe(s1)
  t.teardown(() => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })
}

// FIX-240b: a co-member that applied a leave must keep suppressing the leaver after a restart. The
// in-memory tombstone is gone on restart, so it is durably persisted in the local spaces-meta bee
// and re-seeded when the member view re-opens — covering the creator/root, where revokeApproval is
// a no-op. Never replicated, so it can only ever suppress the leaver in our own fold.

const K = 'a'.repeat(64)

test('REGRESSION (FIX-240b): leave tombstones persist, load, and clear durably', async (t) => {
  await freshPeerWithIdentity(t)
  const S = 'spacetomb0000000'

  t.is((await loadLeftTombstones(S)).size, 0, 'no tombstones initially')

  await persistLeftTombstone(S, K, 12345)
  t.is((await loadLeftTombstones(S)).get(K), 12345, 'persisted with its leave-ts')

  await persistLeftTombstone(S, K, 20000)
  t.is((await loadLeftTombstones(S)).get(K), 20000, 'a later leave overwrites the stamp')

  await clearLeftTombstone(S, K)
  t.is((await loadLeftTombstones(S)).size, 0, 'cleared on rejoin')
  await clearLeftTombstone(S, K)   // idempotent — a second clear must not throw
})

// REGRESSION (FIX-240d): an untrusted/garbage leave-frame ts must never reach tombstoneActive as a
// negative/non-numeric — a negative would flip tombstoneActive false and actively re-admit the
// leaver (undoing the fix). Persist/load clamp it to 0 at both ends.
test('REGRESSION (FIX-240d): persistLeftTombstone sanitizes a negative / non-numeric stamp', async (t) => {
  await freshPeerWithIdentity(t)
  await persistLeftTombstone('spacexxxx0000000', K, -1)
  t.is((await loadLeftTombstones('spacexxxx0000000')).get(K), 0, 'negative stamp clamped to 0')
  await persistLeftTombstone('spaceyyyy0000000', K, 'abc')
  t.is((await loadLeftTombstones('spaceyyyy0000000')).get(K), 0, 'non-numeric stamp clamped to 0')
  await persistLeftTombstone('spacezzzz0000000', K, 1750000000000)
  t.is((await loadLeftTombstones('spacezzzz0000000')).get(K), 1750000000000, 'a valid stamp survives')
})

test('forgetSpaceRecord purges only that space’s leave tombstones', async (t) => {
  await freshPeerWithIdentity(t)
  await persistLeftTombstone('spaceaaaa0000000', 'k1'.padEnd(64, '0'), 1)
  await persistLeftTombstone('spaceaaaa0000000', 'k2'.padEnd(64, '0'), 2)
  await persistLeftTombstone('spacebbbb0000000', 'k3'.padEnd(64, '0'), 3)

  await forgetSpaceRecord('spaceaaaa0000000')
  t.is((await loadLeftTombstones('spaceaaaa0000000')).size, 0, 'left space purged')
  t.is((await loadLeftTombstones('spacebbbb0000000')).size, 1, 'other space untouched')
})

test('REGRESSION (FIX-240b): openMemberView re-seeds the in-memory tombstone from disk', async (t) => {
  await freshPeerWithIdentity(t)

  const { spaceId } = await createSpace('Durable')
  // Simulate a co-member that applied a leave for K in a prior session (durable tombstone on disk),
  // then restarted — the in-memory Map is empty until the view re-opens.
  await persistLeftTombstone(spaceId, K, Date.now())
  t.absent(isLeft(spaceId, K), 'in-memory tombstone empty before the view opens (post-restart)')

  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))

  t.ok(isLeft(spaceId, K), 'opening the view re-seeds the tombstone from durable storage')
})

// REGRESSION (sweep gap): the whole point of FIX-240b — a durably-tombstoned member stays suppressed
// on a fresh view open (post-restart), then SELF-CLEARS when it genuinely rejoins with a newer
// member/<S> ts — was previously exercised nowhere end-to-end. Drive it through the real fold.
test('REGRESSION (FIX-240b): a durable tombstone suppresses on open, then self-clears on a newer rejoin', async (t) => {
  await freshPeerWithIdentity(t)
  const me = getLocalPublicKeyHex()
  const { spaceId } = await createSpace('Rejoin')
  await markOwnMembership(spaceId)                 // creator is an active member (fold root)

  const K = await makePeer(t)                      // a co-member with its own replicated bee
  await K.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await markApproval(spaceId, K.key)               // creator approves K
  replicate(getStore(), K.store, t)

  // We observed K leave at ts 2000 — durable, and it survives into a fresh view open.
  await persistLeftTombstone(spaceId, K.key, 2000)
  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))

  t.ok(await waitFor(() => isMember(spaceId, me)), 'creator derives itself')
  // POSITIVE CONTROL: prove K's bee actually replicated + is readable, so the absence below is a
  // real suppression, not "K hasn't arrived yet" (which would false-pass by timeout).
  t.ok(await waitFor(async () => (await readMembershipRecord(K.key, spaceId))?.active === true),
    'K record replicated + readable (so suppression is genuine, not un-replicated)')
  t.absent(await waitFor(() => isMember(spaceId, K.key), 800), 'K stays suppressed: its record (ts 1000) is older than the leave (2000)')

  // K genuinely rejoins: writes a strictly-newer member/<S> ts.
  await K.bee.put('member/' + spaceId, { active: true, ts: 3000 })
  t.ok(await waitFor(() => isMember(spaceId, K.key)), 'K is re-admitted once its rejoin ts (3000) beats the leave (2000)')
  t.absent(isLeft(spaceId, K.key), 'in-memory tombstone self-cleared')
  // The durable clear (dropTombstone → clearLeftTombstone) is fire-and-forget from the fold, so poll.
  t.ok(await waitFor(async () => (await loadLeftTombstones(spaceId)).size === 0), 'durable tombstone self-cleared too')
})

// V2 fix: markOwnMembership must be idempotent on boot (no ts bump → no reconcile fan-out to
// co-members every restart) yet force a strictly-newer ts on a (re)join (so a co-member that
// tombstoned us self-clears even if the prior leave's clearOwnMembership was swallowed).
test('markOwnMembership: idempotent by default, refresh forces a newer ts', async (t) => {
  await freshPeerWithIdentity(t)
  const me = getLocalPublicKeyHex()
  const S = 'spaceidmp0000000'
  await markOwnMembership(S)
  const ts1 = (await readMembershipRecord(me, S)).memberTs
  t.ok(ts1 > 0, 'first mark stamps a ts')

  await new Promise((r) => setTimeout(r, 5))
  await markOwnMembership(S)                       // boot backfill: must NOT re-stamp
  t.is((await readMembershipRecord(me, S)).memberTs, ts1, 'default is idempotent — ts unchanged')

  await new Promise((r) => setTimeout(r, 5))
  await markOwnMembership(S, { refresh: true })    // (re)join: must bump
  t.ok((await readMembershipRecord(me, S)).memberTs > ts1, 'refresh forces a strictly-newer ts')
})

// V1 fix: a lingering (non-approver) request receipt would otherwise pin the rejoin's ts below our
// leave stamp, so a co-member reading it via replication suppresses the rejoin forever. `refresh`
// (set from onJoinRequest's hadLeft) advances the receipt past the leave.
test('REGRESSION (FIX-240c): markRequest refresh advances a lingering receipt ts', async (t) => {
  await freshPeerWithIdentity(t)
  const me = getLocalPublicKeyHex()
  const S = 'spacereq00000000'
  const J = 'b'.repeat(64)
  const tsOf = async () => (await readPeerRequests(me, S)).find((r) => r.joiner === J).ts

  await markRequest(S, J, { displayName: 'Jo' })
  const t1 = await tsOf()
  await new Promise((r) => setTimeout(r, 5))
  await markRequest(S, J, { displayName: 'Jo' })                  // no refresh → short-circuits
  t.is(await tsOf(), t1, 'a duplicate request keeps the stale receipt ts (no churn)')
  await new Promise((r) => setTimeout(r, 5))
  await markRequest(S, J, { displayName: 'Jo', refresh: true })   // rejoin → fresh ts
  t.ok(await tsOf() > t1, 'refresh advances the receipt ts so the rejoin surfaces past a leave stamp')
})
