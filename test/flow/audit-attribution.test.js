import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, writeTmpFile, patternedBytes } from '../helpers/fixtures.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true, handshakeIdentityBindingEnabled: true })

async function rows (peer, query = {}) {
  const page = await peer.request('audit:list', { limit: 200, ...query })
  return page.entries
}

const kindsOf = (entries) => entries.map((e) => e.kind)
const find = (entries, kind) => entries.find((e) => e.kind === kind)

// The whole value of a tier-B row is that the peer identity in it was authenticated on the
// socket, not merely claimed. This asserts the recorded actor key is the real remote profile
// key — a two-peer test is the only layer that can prove it.
test('a peer join and approval are recorded with the authenticated peer key', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const bKey = (await B.request('profile:get')).publicKey

  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('membership.approved'))
  const aRows = await rows(A)

  const created = find(aRows, 'space.created')
  t.ok(created, 'the creator recorded creating the space')
  t.is(created.tier, 'A', 'own action is first-party')
  t.is(created.space.name, 'Secure Space', 'the space name is snapshotted into the row')

  const approved = find(aRows, 'membership.approved')
  t.ok(approved, 'the approver recorded the approval')
  t.is(approved.target.id, bKey, 'the approved member is the real remote profile key')
  t.is(approved.space.id, spaceId)

  // The approver deliberately gets NO second 'member.joined': 'You approved Bob' already tells
  // that story, and a duplicate row seconds later is noise.
  t.absent(find(aRows, 'member.joined'), 'the approver does not double-report its own approval')

  const bRows = await rows(B)
  t.ok(find(bRows, 'space.joined'), 'the joiner recorded joining')
  t.absent(find(bRows, 'membership.approved'), 'the joiner did not author the approval')
})

test('a denied join is recorded by the decider with a denied outcome', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  const space = await A.request('space:create', { name: 'Closed Space' })
  const inviteCode = await A.request('space:invite', { spaceId: space.spaceId })
  const gotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId, 120000)
  await B.request('space:join', { inviteCode })
  const req = await gotRequest
  await A.request('space:deny-member', { spaceId: space.spaceId, publicKey: req.publicKey })

  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('membership.denied'))
  const denied = find(await rows(A), 'membership.denied')
  t.is(denied.outcome, 'denied', 'the outcome drives the row badge')
  t.is(denied.target.id, req.publicKey)
})

// The log is a deliberate exception to §6's "leave removes everything space-scoped" rule. Without
// the name snapshot the surviving rows would render a raw hex id forever, so both halves are
// asserted together.
test('audit rows survive a space leave, still naming the space', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  await B.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('space.joined'))

  await B.request('space:leave', { spaceId })
  await B.until('spaces:list', {}, (list) => !list.some((s) => s.spaceId === spaceId))

  const after = await rows(B)
  const left = find(after, 'space.left')
  t.ok(left, 'the leave itself is recorded')
  t.is(left.space.name, 'Secure Space', 'the name snapshot outlives the purged space record')

  t.ok(find(after, 'space.joined'), 'the earlier join row was NOT purged with the space')
  t.ok(after.every((e) => e.space === null || e.space.name !== null), 'no surviving row renders as a bare id')

  const spaces = await B.request('audit:spaces')
  t.ok(spaces.some((s) => s.id === spaceId), 'the left space stays available as a filter option')

  const scoped = await rows(B, { spaceId })
  t.ok(scoped.length > 0, 'the by-space index survives the leave too')
})

test('recording can be turned off and back on at runtime', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  await A.request('audit:configure', { enabled: false })
  await A.request('space:create', { name: 'Unrecorded' })
  t.absent((await rows(A)).some((e) => e.space?.name === 'Unrecorded'), 'nothing is written while disabled')

  await A.request('audit:configure', { enabled: true })
  await A.request('space:create', { name: 'Recorded' })
  await A.until('audit:list', { limit: 200 }, (page) => page.entries.some((e) => e.space?.name === 'Recorded'))
  t.pass('recording resumes when re-enabled')

  const purged = await A.request('audit:purge')
  t.ok(purged.purged > 0, 'purge reports what it removed')
  t.is((await rows(A)).length, 0, 'the log is empty after an explicit purge')
})

// REGRESSION (FIX-1): the join guard read connectedPeers — an IN-MEMORY map that is empty at
// every boot — so every already-known member re-registered as a fresh arrival on every app
// start, and the log filled with duplicate "X joined the space" rows. The guard must be the
// durable roster instead.
test('REGRESSION (FIX-1): a member is recorded as joining once, not on every restart', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aStorage = idStore(t)
  const aDownloads = mkTmpDir(t)
  const aFlags = flags()

  let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStorage, downloads: aDownloads, flags: aFlags })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('membership.approved'))
  const before = await rows(A)

  // Restart Alice against the same storage — the real-world trigger. Reconnecting to an
  // already-known member must add nothing, whatever kind it would have been.
  A.kill()
  A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStorage, downloads: aDownloads, flags: aFlags })
  await A.until('members:online', { spaceId }, (online) => online.length > 1)
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const after = await rows(A)
  t.is(after.length, before.length, 'a restart records no new rows at all')
  t.alike(after.map((e) => e.seq), before.map((e) => e.seq), 'the log is byte-for-byte the same set')
})

// A co-member who did NOT approve the newcomer has no other signal that they arrived, so the row
// must still be recorded there — including when they learn it purely through replication rather
// than a direct handshake.
test('a co-member records an arrival it did not approve, with the authenticated key', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)

  // addPeerToSpace waits on member-joined, which never fires while approval gates the join —
  // so run the approval handshake explicitly for the third peer.
  const inviteCode = await A.request('space:invite', { spaceId })
  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId, 120000)
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await C.request('space:join', { inviteCode })
  const req = await aGotRequest
  await A.request('space:approve-member', { spaceId, publicKey: req.publicKey })
  await cGranted

  const cKey = (await C.request('profile:get')).publicKey
  await B.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('member.joined'))

  const joins = (await rows(B)).filter((e) => e.kind === 'member.joined')
  t.is(joins.length, 1, 'exactly one arrival row on the co-member')
  t.is(joins[0].actor.key, cKey, 'tier B: the recorded actor is the real remote profile key')
  t.is(joins[0].tier, 'B')
  t.is(joins[0].actor.name, 'Carol', 'the display name is snapshotted at the time of the event')
})

// REGRESSION (FIX-3): the owner recorded NOTHING when a peer downloaded their file. The serve
// session was closed only by the protocol's onServeEnd, which fires on channel close or grant
// revocation — never on a successful transfer — and the idle sweep stops being scheduled once
// the last live row is dropped. So a completed serve was never recorded at all.
test('REGRESSION (FIX-3): the owner records a peer downloading their file', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const bytes = patternedBytes(256 * 1024, 9)
  await A.request('files:add', { spaceId, filePath: writeTmpFile(bytes, t), fileName: 'movie.bin', fileSize: bytes.length })
  await B.until('files:list', { spaceId }, (l) => l.some((f) => f.path === '/movie.bin'), { ms: 60000, every: 500 })

  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const done = B.waitFor('event:transfer-complete', () => true, 90000)
  await B.request('files:download', { spaceId, ownerKey: aKey, path: '/movie.bin' })
  await done

  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('serve.completed'))
  const served = find(await rows(A), 'serve.completed')
  t.is(served.actor.key, bKey, 'the requester is the Noise-authenticated peer, not a claim')
  t.is(served.actor.name, 'Bob', 'the peer name is snapshotted so the row never renders a bare "?"')
  t.is(served.space.name, 'Secure Space', 'the space name is snapshotted too')
  t.is(served.target.name, 'movie.bin')
  t.is(served.subject.bytes, bytes.length, 'the full transfer size is recorded')
  t.is(served.tier, 'B')

  // The other side of the same transfer, on the downloader.
  const own = find(await rows(B), 'transfer.completed')
  t.ok(own, 'the downloader records its own download')
  t.is(own.tier, 'A')
})

// The three peer-action events: a member publishing a file into a shared space, creating a
// folder share there, and mirroring one of OUR folders. All three are read from that peer's own
// replicated records (tier C) by diffing their bee's history against a durable watermark.
test('a peer publishing a file into a shared space is recorded', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const bKey = (await B.request('profile:get')).publicKey

  // The UI lists a space when you open it, which registers the catalog watch and baselines it.
  // Do the same before Bob acts, so this exercises steady state rather than first contact.
  await A.request('files:list', { spaceId })
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const bytes = patternedBytes(4096, 3)
  await B.request('files:add', { spaceId, filePath: writeTmpFile(bytes, t), fileName: 'notes.txt', fileSize: bytes.length })
  await A.until('files:list', { spaceId }, (l) => l.some((f) => f.path === '/notes.txt'), { ms: 60000, every: 500 })

  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('peer.file_shared'))
  const shared = find(await rows(A), 'peer.file_shared')
  t.is(shared.actor.key, bKey, 'attributed to the peer whose catalog authored it')
  t.is(shared.actor.name, 'Bob')
  t.is(shared.target.name, 'notes.txt')
  t.is(shared.space.name, 'Secure Space')
  t.is(shared.tier, 'C', 'read from their replicated records — their clock, not ours')

  // Our own publish must not be re-reported as a peer action on the other side of the same act.
  t.absent(find(await rows(B), 'peer.file_shared'), 'the publisher records file.shared, not peer.file_shared')
  t.ok(find(await rows(B), 'file.shared'))
})

test('a peer creating a folder share, and mirroring ours, are both recorded', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const bKey = (await B.request('profile:get')).publicKey

  // Bob creates a folder share in the shared space — Alice should see it as a peer action.
  const bobShare = await B.request('share:create', { spaceId, name: 'BobFolder' })
  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('peer.share_created'))
  const created = find(await rows(A), 'peer.share_created')
  t.is(created.actor.key, bKey)
  t.is(created.target.id, bobShare.id)
  t.is(created.target.name, 'BobFolder', 'the folder name is snapshotted from their record')
  t.is(created.tier, 'C')

  // Alice shares a folder; Bob mirrors it. Only mirrors of OUR shares are recorded.
  const aliceShare = await A.request('share:create', { spaceId, name: 'AliceFolder' })
  const dir = mkTmpDir(t)
  await A.request('owned-folder:mount', { spaceId, shareId: aliceShare.id, mountPath: dir })
  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === aliceShare.id), { ms: 60000, every: 500 })

  const aKey = (await A.request('profile:get')).publicKey
  await B.request('foreign-folder:mount', { spaceId, shareId: aliceShare.id, ownerKey: aKey, mountPath: mkTmpDir(t) })

  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('mirror.peer_mirrored'))
  const mirrored = (await rows(A)).filter((e) => e.kind === 'mirror.peer_mirrored')
  t.is(mirrored.length, 1, 'the syncing->active state churn collapses into one row')
  t.is(mirrored[0].actor.key, bKey)
  t.is(mirrored[0].target.name, 'AliceFolder', 'named as OUR folder, which is what the owner cares about')
  t.is(mirrored[0].tier, 'C')

  // Bob mirrors his own share too — Alice must not report a mirror of a folder that is not hers.
  t.is((await rows(A)).filter((e) => e.kind === 'mirror.peer_mirrored' && e.target.id === bobShare.id).length, 0,
    'a mirror of someone else\'s folder is not our business')

  // REGRESSION (FIX-4): a mirror is tombstoned with `unmirroredAt`, not the `deletedAt` a share
  // uses. Reading the wrong field made an unmirror look like a fresh mirror — the stop was lost
  // AND a duplicate "mirrored" row appeared in its place.
  await B.request('foreign-folder:unmount', { spaceId, shareId: aliceShare.id })
  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('mirror.peer_unmirrored'))
  t.is((await rows(A)).filter((e) => e.kind === 'mirror.peer_unmirrored').length, 1, 'the stop is recorded exactly once')
  t.is((await rows(A)).filter((e) => e.kind === 'mirror.peer_mirrored').length, 1,
    'and it did not masquerade as a second "mirrored" row')
})
