import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir, waitForFile } from '../helpers/fixtures.js'

// End-to-end regression for the leave→rejoin gate. A peer that shared a folder, left, and rejoins
// must NOT have its previously-mirrored folder re-surface on the other peer before re-approval, and
// a departed non-creator must be re-approved before it is a member again.
//   FIX-1 (tombstoneShare on leave): the retired share advertisement keeps the folder hidden — even
//          for the creator, who is re-recognized as the OR-Set root on rejoin.
//   FIX-2 (revokeApproval on leave): a departed non-creator is not auto-readmitted off the surviving
//          grow-only approval; it shows as a pending request until explicitly re-approved.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true })

const memberKeys = async (peer, spaceId) => {
  const s = (await peer.request('spaces:list')).find((x) => x.spaceId === spaceId)
  return new Set((s?.members || []).map((m) => m.publicKey))
}
const status = async (peer, spaceId) =>
  (await peer.request('spaces:list')).find((s) => s.spaceId === spaceId)?.status
const hasShare = async (peer, spaceId, shareId) =>
  (await peer.request('share:list', { spaceId })).some((s) => s.id === shareId)
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

async function createApprovedSpace (A, B) {
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const space = await A.request('space:create', { name: 'Vault' })
  const spaceId = space.spaceId
  const invite = await A.request('space:invite', { spaceId })
  const aGotB = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey, 120000)
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await B.request('space:join', { inviteCode: invite })
  await aGotB
  await A.request('space:approve-member', { spaceId, publicKey: bKey })
  await bGranted
  await A.until('spaces:list', {}, (l) => {
    const s = l.find((x) => x.spaceId === spaceId)
    return !!(s && s.members.some((m) => m.publicKey === bKey && m.status !== 'pending'))
  }, { ms: 60000, every: 1000 })
  return { spaceId, invite, aKey, bKey }
}

async function shareFolder (t, sharer, spaceId, name) {
  const share = await sharer.request('share:create', { spaceId, name })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'note.txt'), 'mirror me')
  const scan = sharer.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id, 60000)
  await sharer.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scan
  return share
}

async function mirrorFolder (t, mirrorer, spaceId, share, ownerKey) {
  await mirrorer.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id), { ms: 60000 })
  const mirrorDir = mkTmpDir(t)
  const active = mirrorer.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 60000)
  await mirrorer.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey, mountPath: mirrorDir })
  await active
  // 'active' marks the mount established, but overlay materialization (fetch-from-holder)
  // is async and can land the file after the first scan — wait for the shared file so
  // callers can assert on it (shareFolder always writes note.txt).
  await waitForFile(path.join(mirrorDir, 'note.txt'))
  return mirrorDir
}

test('REGRESSION (FIX-1+FIX-2): a non-creator member leaving and rejoining stays hidden until re-approval', { timeout: 300000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const { spaceId, invite, bKey } = await createApprovedSpace(A, B)

  // B (the non-creator) shares a folder; A (creator) mirrors it.
  const share = await shareFolder(t, B, spaceId, 'Docs')
  await mirrorFolder(t, A, spaceId, share, bKey)
  t.ok(await hasShare(A, spaceId, share.id), 'A sees and mirrors B’s share')

  // B leaves → A drops B and B’s share.
  await B.request('space:leave', { spaceId })
  await A.until('share:list', { spaceId }, (l) => !l.some((s) => s.id === share.id), { ms: 120000 })
  t.absent((await memberKeys(A, spaceId)).has(bKey), 'B removed from A’s members on leave')

  // B rejoins via the same invite. A must raise a fresh join request, not auto-readmit.
  let grantedBeforeApproval = false
  B.on('event:membership-granted', (m) => { if (m.spaceId === spaceId) grantedBeforeApproval = true })
  const aGotRejoin = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey, 120000)
  await B.request('space:join', { inviteCode: invite })
  await aGotRejoin

  // BEFORE re-approval: give any (wrong) re-admit / silent SCK re-grant time to land, then assert none did.
  await settle(8000)
  t.absent(grantedBeforeApproval, 'FIX-1 (race): B is not silently re-granted the SCK before re-approval')
  t.absent((await memberKeys(A, spaceId)).has(bKey), 'FIX-2: B is NOT a member before re-approval')
  t.absent(await hasShare(A, spaceId, share.id), 'FIX-1: B’s old share stays hidden before re-approval')
  t.is(await status(B, spaceId), 'pending', 'B is waiting for approval')

  // AFTER re-approval: B is a member again, but the retired share does not auto-return.
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await A.request('space:approve-member', { spaceId, publicKey: bKey })
  await bGranted
  await A.until('spaces:list', {}, (l) => {
    const s = l.find((x) => x.spaceId === spaceId)
    return !!(s && s.members.some((m) => m.publicKey === bKey && m.status !== 'pending'))
  }, { ms: 60000, every: 1000 })
  await settle(4000)
  t.absent(await hasShare(A, spaceId, share.id), 'FIX-1: the retired share does not auto-return after re-approval (must re-share)')
})

test('REGRESSION (FIX-1): the creator leaving and rejoining does not re-surface its stale folder', { timeout: 300000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const { spaceId, invite, aKey } = await createApprovedSpace(A, B)

  // A (the creator) shares a folder; B mirrors it.
  const share = await shareFolder(t, A, spaceId, 'Photos')
  await mirrorFolder(t, B, spaceId, share, aKey)
  t.ok(await hasShare(B, spaceId, share.id), 'B sees and mirrors the creator’s share')

  // The creator leaves → B drops it and its share.
  await A.request('space:leave', { spaceId })
  await B.until('share:list', { spaceId }, (l) => !l.some((s) => s.id === share.id), { ms: 120000 })

  // The creator rejoins. B re-recognizes it as the OR-Set root; we approve to complete the handshake.
  const bGotRejoin = B.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === aKey, 120000)
  const aGranted = A.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await A.request('space:join', { inviteCode: invite })
  await bGotRejoin
  await B.request('space:approve-member', { spaceId, publicKey: aKey })
  await aGranted
  await B.until('spaces:list', {}, (l) => {
    const s = l.find((x) => x.spaceId === spaceId)
    return !!(s && s.members.some((m) => m.publicKey === aKey))
  }, { ms: 60000, every: 1000 })

  // Creator is back as a member, but its stale share must NOT re-surface (FIX-1 holds for the root).
  await settle(4000)
  t.ok((await memberKeys(B, spaceId)).has(aKey), 'creator is re-recognized as a member on rejoin')
  t.absent(await hasShare(B, spaceId, share.id), 'FIX-1: the creator’s stale share does not re-surface')
})

test('REGRESSION (FIX-2 guard): a transient reconnect (no leave) keeps membership and the mirror', { timeout: 300000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const bStorage = idStore(t)
  const bDownloads = mkTmpDir(t)
  // B is relaunched, so its KEK must stay fixed across boots — a fresh KEK can't unlock identity.enc.
  const bBoot = { identityKEK: kekHex(), handshakeIdentityBindingEnabled: true }
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads, flags: bBoot })
  const { spaceId, bKey } = await createApprovedSpace(A, B)

  const share = await shareFolder(t, B, spaceId, 'Docs')
  await mirrorFolder(t, A, spaceId, share, bKey)

  // B "goes offline" — a hard kill, NOT a leave (no leave frame, no revoke, no share tombstone).
  let sawRejoinReq = false
  A.on('event:member-join-request', (m) => { if (m.spaceId === spaceId && m.publicKey === bKey) sawRejoinReq = true })
  const bPid = B.sidecar?._process?.pid
  B.kill()
  if (bPid) await waitForWorkerExit(bPid, 8000)   // release the RocksDB lock before B2 reopens the store
  const B2 = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads, flags: bBoot })
  await B2.until('spaces:list', {}, (l) => l.some((x) => x.spaceId === spaceId && x.status !== 'pending'), { ms: 60000, every: 1000 })

  // Reconnect must restore silently: no re-approval prompt, B stays a member, the share stays.
  await settle(8000)
  t.absent(sawRejoinReq, 'no re-approval prompt on a transient reconnect')
  t.ok((await memberKeys(A, spaceId)).has(bKey), 'B remains a member across the reconnect')
  t.ok(await hasShare(A, spaceId, share.id), 'B’s share stays visible across the reconnect')
})

// FIX-4 (end-to-end): when the OWNER leaves, the surviving mirrorer tears its orphaned foreign mount
// down (the materialize loop stops; materialized files stay on disk). This asserts the user-facing
// outcome; the deterministic red-first guard for the "owner no longer a member" backstop specifically
// is test/integration/foreign-owner-left.test.js (this flow timing is also covered by FIX-1's
// share tombstone replicating during the leave flush). Short poll makes the teardown assert promptly.
test('REGRESSION (FIX-4): the mirrorer unmounts an orphaned foreign folder when the owner leaves', { timeout: 300000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  // Fast poll for prompt orphan teardown, but keep the DEFAULT peer-read budget: the overlay
  // mirror reads the owner's share record + catalog over peer bees (bounded by peerReadTimeoutMs),
  // and a 1s budget starves those reads on a slow CI runner so nothing materializes. The teardown
  // is driven by the replicated share tombstone, not a read timeout, so it stays prompt regardless.
  const pollFlags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true, foreignPollIntervalMs: 1500 })
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: pollFlags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: pollFlags() })
  const { spaceId, bKey } = await createApprovedSpace(A, B)

  // B shares; A mirrors → A holds a foreign mount + a materialized file.
  const share = await shareFolder(t, B, spaceId, 'Docs')
  const mirrorDir = await mirrorFolder(t, A, spaceId, share, bKey)
  const mirroredFile = path.join(mirrorDir, 'note.txt')
  t.ok(fs.existsSync(mirroredFile), 'mirrored file materialized on A')
  t.ok((await A.request('foreign-folder:list-all')).some((m) => m.shareId === share.id), 'A holds the foreign mount')

  // B leaves → A's materialize loop tears the orphaned mount down.
  await B.request('space:leave', { spaceId })
  await A.until('foreign-folder:list-all', {}, (l) => Array.isArray(l) && !l.some((m) => m.shareId === share.id), { ms: 30000 })
  t.absent((await A.request('foreign-folder:list-all')).some((m) => m.shareId === share.id), 'FIX-4: orphaned mount torn down after the owner left')
  t.ok(fs.existsSync(mirroredFile), 'materialized files stay on disk (matches owner-delete behaviour)')
})
