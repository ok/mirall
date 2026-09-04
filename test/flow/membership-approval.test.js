import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex() })

test('joiner is pending, member approves, then files converge', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: space.spaceId })

  const share = await A.request('share:create', { spaceId: space.spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'plan.bin'), patternedBytes(8 * 1024, 3))
  const scan = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId: space.spaceId, shareId: share.id, mountPath: folder })
  await scan

  const aReq = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aReq
  const bSpaces = await B.request('spaces:list')
  t.is(bSpaces.find((s) => s.spaceId === space.spaceId)?.status, 'pending', 'B is pending')

  // REGRESSION (MIR-01, #326): the overlay catalog is SCK-encrypted, so a pending joiner (no SCK)
  // can replicate the share DESCRIPTOR but NOT list its file METADATA. B seeing the "Docs" share
  // proves it replicated A's profile, so the empty file list below is the SCK gate — not replication
  // lag. The content SERVE gate is separately covered by test/unit/overlay-authorize.test.js.
  await B.until('share:list', { spaceId: space.spaceId },
    (list) => Array.isArray(list) && list.some((s) => s.id === share.id))
  const bPre = await B.request('share:list-files', { spaceId: space.spaceId, ownerKey: aKey, shareId: share.id })
  t.absent((bPre?.entries || []).some((e) => e.relPath === 'plan.bin'),
    'pending joiner cannot list encrypted-catalog metadata before approval')

  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await A.request('space:approve-member', { spaceId: space.spaceId, publicKey: bKey })
  await bGranted

  await B.until('share:list-files', { spaceId: space.spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'plan.bin'))
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Docs/plan.bin', 60000)
  await B.request('share:read-file', { spaceId: space.spaceId, ownerKey: aKey, shareId: share.id, relPath: 'plan.bin' })
  const completed = await done
  t.ok(fs.existsSync(completed.localPath), 'approved member reads the previously-unreadable file')
})

// REGRESSION (FIX-APPROVE-LAG): the approver's pending banner clears as soon as the durable approval
// is recorded — it must NOT wait for the time-bounded joiner-membership capture. B is killed before
// approval so captureJoinerMembership runs to its full timeout; the banner-clear hint must still land
// almost immediately, while the approve RPC (which awaits the capture) stays outstanding.
test('REGRESSION (FIX-APPROVE-LAG): approver pending clears without waiting for joiner capture', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const CAPTURE_MS = 3000
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: { ...v2flags(), captureMemberRecordMs: CAPTURE_MS } })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const bKey = (await B.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: space.spaceId })

  const aReq = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aReq

  // B offline before approval → it never authors/replicates its member record, so
  // captureJoinerMembership on A holds a sparse copy it can't complete and runs to the full timeout.
  B.kill()

  const cleared = A.waitFor('event:join-requests-updated', (m) => m.spaceId === space.spaceId, 1500)
  const approved = A.request('space:approve-member', { spaceId: space.spaceId, publicKey: bKey })

  await cleared   // pre-fix: rejects (emit only after ~CAPTURE_MS); post-fix: resolves fast
  t.alike(await A.request('space:pending-requests', { spaceId: space.spaceId }), [], 'A pending list empty right after approval')

  // The approve RPC still awaits the capture, proving we reordered the emit rather than skipping it.
  const outstanding = await Promise.race([
    approved.then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('pending'), 800)),
  ])
  t.is(outstanding, 'pending', 'approve RPC still in flight (capture running) while the banner already cleared')
  await approved
})

test('deny path: the requester is not admitted', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const space = await A.request('space:create', { name: 'Secret' })
  const bKey = (await B.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: space.spaceId })

  const aReq = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  const bDenied = B.waitFor('event:membership-denied', (m) => m.spaceId === space.spaceId)
  await B.request('space:join', { inviteCode: invite })
  await aReq
  await A.request('space:deny-member', { spaceId: space.spaceId, publicKey: bKey })
  await bDenied

  const aSpaces = await A.request('spaces:list')
  const members = aSpaces.find((s) => s.spaceId === space.spaceId)?.members || []
  t.absent(members.some((m) => m.publicKey === bKey && m.status === 'approved'), 'denied requester is not an approved member')

  // REGRESSION: a denied joiner never joined, so the pending space is dropped from
  // his list automatically — he must not have to "leave" a space he never joined.
  await B.until('spaces:list', {}, (l) => !l.some((s) => s.spaceId === space.spaceId), { ms: 30000, every: 500 })
  t.absent((await B.request('spaces:list')).some((s) => s.spaceId === space.spaceId), 'denied pending space auto-removed from joiner')
})

// REGRESSION: a pending space has no materialized own drive, so the heavyweight
// leave teardown crashed on the closing cores (SESSION_CLOSED). Cancelling a
// pending request must be a clean, lightweight removal.
test('cancelling (leaving) a pending space removes it without crashing', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const space = await A.request('space:create', { name: 'Secret' })
  const invite = await A.request('space:invite', { spaceId: space.spaceId })
  const bKey = (await B.request('profile:get')).publicKey

  const aReq = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aReq
  t.is((await B.request('spaces:list')).find((s) => s.spaceId === space.spaceId)?.status, 'pending', 'B is pending')

  const res = await B.request('space:leave', { spaceId: space.spaceId })
  t.ok(res?.ok, 'leave resolves cleanly')
  t.absent((await B.request('spaces:list')).some((s) => s.spaceId === space.spaceId), 'pending space removed')
})

// SECURITY: member-only operations must be refused at the data layer for a peer
// that holds no content key (pending), not merely hidden in the UI.
test('a pending member cannot invite, approve, deny, or rename the space', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const space = await A.request('space:create', { name: 'Secret' })
  const invite = await A.request('space:invite', { spaceId: space.spaceId })
  const bKey = (await B.request('profile:get')).publicKey

  const aReq = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aReq
  t.is((await B.request('spaces:list')).find((s) => s.spaceId === space.spaceId)?.status, 'pending', 'B is pending')

  await t.exception(() => B.request('space:invite', { spaceId: space.spaceId }), /joined|member/i, 'invite refused while pending')
  // REGRESSION (FIX-INVITE-NULL-1: an unknown space resolved null, which the modal read as success —
  // the button re-enabled with no code and no reason shown.)
  await t.exception(() => A.request('space:invite', { spaceId: 'no-such-space' }), /not found/i, 'unknown space rejects')
  t.is(await B.request('space:approve-member', { spaceId: space.spaceId, publicKey: 'a'.repeat(64) }), false, 'approve refused (no content key)')
  t.is(await B.request('space:deny-member', { spaceId: space.spaceId, publicKey: 'a'.repeat(64) }), false, 'deny refused while pending')
  t.is(await B.request('space:update', { spaceId: space.spaceId, name: 'Hijacked', icon: 'folder' }), null, 'rename refused while pending')
})

test('no approver online → joiner stays pending without failure', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const space = await A.request('space:create', { name: 'Secret' })
  const invite = await A.request('space:invite', { spaceId: space.spaceId })
  A.kill()

  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  await B.request('space:join', { inviteCode: invite })
  const bSpaces = await B.request('spaces:list')
  t.is(bSpaces.find((s) => s.spaceId === space.spaceId)?.status, 'pending', 'B waits, no failure')
})

// Auto-approve links are reusable until expiry (not single-use): every redeemer is admitted with
// no prompt. (Previously the nonce was consumed and the second joiner fell back to manual.)
test('auto-approve invite is reusable — every redeemer is admitted with no prompt', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const space = await A.request('space:create', { name: 'Open' })
  const invite = await A.request('space:invite', { spaceId: space.spaceId, autoAdmit: true })
  const bKey = (await B.request('profile:get')).publicKey

  let prompted = false
  A.on('event:member-join-request', () => { prompted = true })
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await B.request('space:join', { inviteCode: invite })
  await bGranted
  await A.until('spaces:list', {}, (l) => (l.find((s) => s.spaceId === space.spaceId)?.members || [])
    .some((m) => m.publicKey === bKey), { ms: 60000, every: 1000 })

  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const cKey = (await C.request('profile:get')).publicKey
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await C.request('space:join', { inviteCode: invite })
  await cGranted
  await A.until('spaces:list', {}, (l) => (l.find((s) => s.spaceId === space.spaceId)?.members || [])
    .some((m) => m.publicKey === cKey), { ms: 60000, every: 1000 })

  t.absent(prompted, 'reusable auto-approve link admits both joiners with no manual prompt')
})

// REGRESSION (MIR-01): a member still pending approval holds no content key and must
// never be asked to approve another joiner.
test('a pending member does not receive join requests for other joiners', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const space = await A.request('space:create', { name: 'Secret' })
  const invite = await A.request('space:invite', { spaceId: space.spaceId })
  const bKey = (await B.request('profile:get')).publicKey

  // B joins and stays pending (never approved).
  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  t.is((await B.request('spaces:list')).find((s) => s.spaceId === space.spaceId)?.status, 'pending', 'B is pending')

  // Watch B for any join request once Carol joins.
  let bGotRequest = false
  B.on('event:member-join-request', () => { bGotRequest = true })

  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const cKey = (await C.request('profile:get')).publicKey
  await C.request('space:join', { inviteCode: invite })
  // The approved creator A does record Carol's request — proves Carol is broadcasting it.
  await A.until('space:pending-requests', { spaceId: space.spaceId },
    (reqs) => reqs.some((r) => r.publicKey === cKey), { ms: 90000, every: 1000 })
  await new Promise((r) => setTimeout(r, 2000))

  t.absent(bGotRequest, 'pending Bob is never asked to approve Carol')
  t.alike(await B.request('space:pending-requests', { spaceId: space.spaceId }), [], 'pending member records no requests')
})

test("a pending joiner pulls the inviter's avatar onto the pre-seeded member", { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/1eOAAAAAElFTkSuQmCC'
  await A.request('profile:set', { displayName: 'Alice', avatar: AVATAR })
  const aKey = (await A.request('profile:get')).publicKey
  const space = await A.request('space:create', { name: 'Secret' })
  const invite = await A.request('space:invite', { spaceId: space.spaceId })

  await B.request('space:join', { inviteCode: invite })
  // spaces:list rosters are slim (no avatars) — the avatar rides the full space:members roster.
  await B.until('space:members', { spaceId: space.spaceId },
    (roster) => Array.isArray(roster) && roster.some((m) => m.publicKey === aKey && m.avatar === AVATAR),
    { ms: 90000, every: 1000 })
  t.is((await B.request('spaces:list')).find((s) => s.spaceId === space.spaceId)?.status, 'pending', 'B is still pending')
})
