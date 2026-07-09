import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// REGRESSION (G4): a leave interrupted by a hard quit must COMPLETE at the next boot, not
// silently reverse. Before the fix, the space record survived the crash (only the in-memory
// leavingSpaces marker existed) and boot's markOwnMembership backfill re-PUT active:true —
// the leaver's space resurrected locally and co-members saw it return.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
const memberKeys = async (peer, spaceId) =>
  new Set(((await peer.request('spaces:list')).find((x) => x.spaceId === spaceId)?.members || []).map((m) => m.publicKey))

test('REGRESSION (G4): a leave interrupted by a hard quit completes at the next boot', { timeout: 300000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true, handshakeIdentityBindingEnabled: true })
  // B is relaunched, so its KEK + storage must stay fixed across boots.
  const bStorage = idStore(t)
  const bDownloads = mkTmpDir(t)
  const bBoot = flags()
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads, flags: bBoot })

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
    return !!(s && s.members.some((m) => m.publicKey === bKey))
  }, { ms: 60000, every: 1000 })

  // Kill B the moment A observes the leave frame: the frame is sent AFTER the durable leaving
  // marker + member del land, and the teardown then holds ≥500ms in awaitLeaveAcks (hard floor)
  // before forgetSpaceRecord — so the kill deterministically lands mid-teardown, with the space
  // record (and the marker) still on disk.
  const frameSeen = A.waitFor('event:member-left', (m) => m.spaceId === spaceId && m.publicKey === bKey, 60000)
  B.request('space:leave', { spaceId }).catch(() => {})
  await frameSeen
  const bPid = B.sidecar?._process?.pid
  B.kill()
  if (bPid) await waitForWorkerExit(bPid, 8000)

  const B2 = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads, flags: bBoot })
  // Pre-fix this times out: the surviving record kept the space in the list and boot re-marked
  // the membership active.
  await B2.until('spaces:list', {}, (l) => l.every((x) => x.spaceId !== spaceId), { ms: 60000, every: 1000 })
  t.pass('space gone on the relaunched leaver — boot completed the interrupted leave')

  // Pre-fix the re-mark (a fresh, newer ts) lifted A's leave tombstone and B resurfaced.
  await settle(8000)
  t.absent((await memberKeys(A, spaceId)).has(bKey), 'the leaver does not resurrect in the co-member roster')
})
