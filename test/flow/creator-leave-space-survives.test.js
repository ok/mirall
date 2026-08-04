import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// REGRESSION (FIX-361: creator-leave collapse): the peer that CREATED a space leaves it. Every
// remaining member must keep converging membership.
//
// Most of this scenario is masked while peers are online, and the masking is stronger than it
// looks: the handshake gate admits off space.members + readPeerApproval rather than off the fold,
// and reconcile retains unconsidered peers instead of dropping them. With an unrooted fold, Bob
// still holds Carol, Carol still converges Dave on reconnect, and the departed creator still drops.
// Every one of those passes either way.
//
// The assertion that actually discriminates is the LAST one: Dave, who joined after the creator
// left, must see Carol. Dave's fold is rooted at the departed creator, so an unrooted fold derives
// nobody for him, and the handshake gate cannot rescue it — Carol was vouched by the creator, not
// by Bob, so readPeerApproval finds no vouch Dave can verify and Carol is never admitted. Dave ends
// up in a space whose existing members are invisible to him. Do not drop that assertion.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true, handshakeIdentityBindingEnabled: true })
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const memberKeys = (list, spaceId) =>
  new Set((list.find((s) => s.spaceId === spaceId)?.members || []).map((m) => m.publicKey))
const holds = (spaceId, key) => (list) => memberKeys(list, spaceId).has(key)
const lacks = (spaceId, key) => (list) => !memberKeys(list, spaceId).has(key)

async function joinApproved (approver, joiner, spaceId, inviteCode) {
  const joinerKey = (await joiner.request('profile:get')).publicKey
  const seen = approver.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === joinerKey)
  await joiner.request('space:join', { inviteCode })
  await seen
  const granted = joiner.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await approver.request('space:approve-member', { spaceId, publicKey: joinerKey })
  await granted
  return joinerKey
}

test('FIX-361: a space keeps converging after its creator leaves', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const mk = (displayName, storage = idStore(t), flagSet = flags()) =>
    launchPeer(t, { bootstrap, displayName, storage, downloads: mkTmpDir(t), flags: flagSet })

  const A = await mk('Alice')
  const B = await mk('Bob')
  const carolStorage = idStore(t)
  const carolFlags = flags()
  const C = await mk('Carol', carolStorage, carolFlags)

  const { spaceId } = await A.request('space:create', { name: 'Quartet' })
  const inviteA = await A.request('space:invite', { spaceId })

  const aKey = (await A.request('profile:get')).publicKey
  const bKey = await joinApproved(A, B, spaceId, inviteA)
  const cKey = await joinApproved(A, C, spaceId, inviteA)

  await B.until('spaces:list', {}, holds(spaceId, cKey), { ms: 60000 })
  await C.until('spaces:list', {}, holds(spaceId, bKey), { ms: 60000 })
  t.pass('baseline: Bob and Carol hold each other')

  // Carol goes offline for everything that follows.
  const cPid = C.sidecar?._process?.pid
  C.kill()
  if (cPid) await waitForWorkerExit(cPid, 5000)
  await new Promise((r) => setTimeout(r, scaled(2000)))

  await A.request('space:leave', { spaceId })
  await B.until('spaces:list', {}, lacks(spaceId, aKey), { ms: 60000 })
  t.pass('Bob applied the creator\'s departure')

  // Bob — a co-member, not the creator — invites and approves Dave while Carol is away.
  const inviteB = await B.request('space:invite', { spaceId })
  const D = await mk('Dave')
  const dKey = await joinApproved(B, D, spaceId, inviteB)
  t.pass('Bob invited and approved Dave with the creator gone')

  const C2 = await launchPeer(t, {
    bootstrap, displayName: 'Carol', storage: carolStorage, downloads: mkTmpDir(t), flags: carolFlags,
  })

  await C2.until('spaces:list', {}, holds(spaceId, dKey), { ms: 120000 })
  t.pass('Carol converged Dave purely by replication — the fold still walks the tree')

  await C2.until('spaces:list', {}, lacks(spaceId, aKey), { ms: 60000 })
  t.pass('Carol dropped the departed creator (liveness still applies to the root)')

  const carolNow = memberKeys(await C2.request('spaces:list', {}), spaceId)
  t.ok(carolNow.has(bKey), 'Carol still holds Bob — authorization survived the root leaving')

  await D.until('spaces:list', {}, holds(spaceId, bKey), { ms: 60000 })
  await D.until('spaces:list', {}, holds(spaceId, cKey), { ms: 120000 })
  t.pass('Dave sees the surviving roster')
})
