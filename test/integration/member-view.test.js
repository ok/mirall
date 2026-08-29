import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { freshPeerWithIdentity, freshDurableWithIdentity } from '../helpers/store.js'
import { getStore } from '../../src/shared/core/store.js'
import {
  getLocalPublicKeyHex, markOwnMembership, markApproval, clearOwnMembership, readMembershipRecord,
} from '../../src/shared/spaces/profile.js'
import { createMemberView } from '../../src/shared/spaces/member-view.js'

const sorted = (it) => [...it].sort()

function tmpDir () {
  const dir = path.join(os.tmpdir(), `mv-peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function waitFor (pred, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return pred()
}

// A standalone "peer": its own Corestore + a plain (unencrypted, like real profile bees)
// membership bee, replicated into the local store so openProfileBee(peerKey) can read it —
// the in-process stand-in for a remote member whose bee has replicated to us.
async function makePeer (t) {
  const dir = tmpDir()
  const store = new Corestore(dir)
  await store.ready()
  const core = store.get({ name: 'profile' })
  await core.ready()
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.put('caps/membership-manifest', true)
  const key = b4a.toString(core.key, 'hex')
  t.teardown(async () => {
    try { await store.close() } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return { store, bee, key }
}

function replicate (a, b, t) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })
}

// The durable tier only: boot() publishes the manifest cap this test asserts is absent.
test('readMembershipRecord returns { active, approvals }, cap-gated', async (t) => {
  await freshDurableWithIdentity(t)
  const me = getLocalPublicKeyHex()
  const S = 'space-read'

  t.is(await readMembershipRecord(me, S), null, 'no manifest cap → null (unknown)')

  await markOwnMembership(S)
  await markApproval(S, 'joiner-1')
  await markApproval(S, 'joiner-2')

  const rec = await readMembershipRecord(me, S)
  t.is(rec.active, true, 'own membership active')
  t.alike(sorted(rec.approvals), ['joiner-1', 'joiner-2'], 'both authored approvals')
})

test('a left member reads active:false (leave tombstone)', async (t) => {
  await freshPeerWithIdentity(t)
  const me = getLocalPublicKeyHex()
  const S = 'space-leave'

  await markOwnMembership(S)
  t.is((await readMembershipRecord(me, S)).active, true)
  await clearOwnMembership(S)
  t.is((await readMembershipRecord(me, S)).active, false, 'after leave, active:false (not null)')
})

test('createMemberView derives a replicated co-member and re-derives transitively', async (t) => {
  await freshPeerWithIdentity(t)              // local peer = the creator
  const creator = getLocalPublicKeyHex()
  const S = 'space-view'
  await markOwnMembership(S)

  const B = await makePeer(t)                 // a co-member, its own store
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await markApproval(S, B.key)                // creator approves B
  replicate(getStore(), B.store, t)           // B's bee replicates to us

  let latest = null
  const mv = createMemberView({ spaceId: S, creatorKey: creator, selfKey: creator, onMembers: ({ members }) => { latest = new Set(members) } })
  t.teardown(() => mv.close())

  t.ok(await waitFor(() => latest?.has(B.key)), 'derived the replicated co-member B')
  t.alike(sorted(latest), sorted([creator, B.key]), 'creator + B')

  // B approves a third member D (its own store, replicated). A change to B's WATCHED bee
  // re-derives and pulls D in transitively — driven purely by replication, no gossip.
  const D = await makePeer(t)
  await D.bee.put('member/' + S, { active: true, ts: 1 })
  replicate(getStore(), D.store, t)
  await B.bee.put('approved/' + S + '/' + D.key, { ts: 2 })

  t.ok(await waitFor(() => latest?.has(D.key)), 'D discovered after B approved it')
  t.alike(sorted(latest), sorted([creator, B.key, D.key]), 'creator + B + D')
})

test('onBeeAppend fires per share-record append and ignores non-share appends (range-scoped)', async (t) => {
  await freshPeerWithIdentity(t)
  const creator = getLocalPublicKeyHex()
  const S = 'space-append'
  await markOwnMembership(S)

  const B = await makePeer(t)
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await markApproval(S, B.key)
  replicate(getStore(), B.store, t)

  const pokes = []
  let latest = null
  const mv = createMemberView({
    spaceId: S,
    creatorKey: creator,
    selfKey: creator,
    onMembers: ({ members }) => { latest = new Set(members) },
    onBeeAppend: (key) => pokes.push(key),
  })
  t.teardown(() => mv.close())
  t.ok(await waitFor(() => latest?.has(B.key)), 'B derived (its bee is followed)')

  const before = pokes.length
  await B.bee.put('share/' + S + '/photos', { name: 'Photos' })
  t.ok(await waitFor(() => pokes.length > before), 'a share/<space>/ append pokes onBeeAppend')
  t.ok(pokes.slice(before).every((k) => k === B.key), 'the poke carries the appending member key')

  const afterShare = pokes.length
  await B.bee.put('avatar', 'not-a-share-record')
  await B.bee.put('member/space-elsewhere', { active: true, ts: 2 })
  await B.bee.put('share/space-elsewhere/docs', { name: 'Docs' })
  await new Promise((r) => setTimeout(r, 500))
  t.is(pokes.length, afterShare, 'avatar/membership/other-space appends do not poke (range-scoped)')
})

test('createMemberView drops a co-member when their record flips to inactive', async (t) => {
  await freshPeerWithIdentity(t)
  const creator = getLocalPublicKeyHex()
  const S = 'space-drop'
  await markOwnMembership(S)

  const B = await makePeer(t)
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await markApproval(S, B.key)
  replicate(getStore(), B.store, t)

  let latest = null
  const mv = createMemberView({ spaceId: S, creatorKey: creator, selfKey: creator, onMembers: ({ members }) => { latest = new Set(members) } })
  t.teardown(() => mv.close())

  t.ok(await waitFor(() => latest?.has(B.key)), 'B present')

  await B.bee.del('member/' + S)              // B leaves; the tombstone replicates
  t.ok(await waitFor(() => latest && !latest.has(B.key)), 'B dropped after leaving')
  t.ok(latest.has(creator), 'creator still a member')
})
