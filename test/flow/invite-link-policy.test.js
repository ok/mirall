import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// Per-link invite policy end to end: auto-approve, review, expiry, and the load-bearing proof that
// the per-link record is REPLICATED — a co-member enforces an auto-approve link the minter never
// resolved (the minter is offline). Mirrors membership-approval.test.js / three-peer-approval.test.js.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true })
const memberKeys = async (peer, spaceId) => {
  const s = (await peer.request('spaces:list')).find((x) => x.spaceId === spaceId)
  return new Set((s?.members || []).map((m) => m.publicKey))
}
const status = async (peer, spaceId) =>
  (await peer.request('spaces:list')).find((s) => s.spaceId === spaceId)?.status

test('REGRESSION (FIX-1): an auto-approve link admits with no manual approval', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const space = await A.request('space:create', { name: 'Open' })
  const bKey = (await B.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: space.spaceId, autoAdmit: true, expiresInMs: 2 * 60 * 60 * 1000 })

  let prompted = false
  A.on('event:member-join-request', () => { prompted = true })
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await B.request('space:join', { inviteCode: invite })
  await bGranted
  await A.until('spaces:list', {}, (l) => (l.find((s) => s.spaceId === space.spaceId)?.members || [])
    .some((m) => m.publicKey === bKey && m.status === 'approved'), { ms: 60000, every: 1000 })
  t.absent(prompted, 'no manual approval was required')
})

test('a review link (auto-approve off) still requires manual approval', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const space = await A.request('space:create', { name: 'Reviewed' })
  const bKey = (await B.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: space.spaceId, autoAdmit: false, expiresInMs: 2 * 60 * 60 * 1000 })

  const aReq = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aReq
  t.is((await B.request('spaces:list')).find((s) => s.spaceId === space.spaceId)?.status, 'pending', 'review link leaves the joiner pending')
})

test('an expired link is refused at join', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const space = await A.request('space:create', { name: 'Stale' })
  // expiresInMs in the past (beyond the 60s joiner-side grace) → an already-expired link.
  const invite = await A.request('space:invite', { spaceId: space.spaceId, autoAdmit: true, expiresInMs: -120000 })

  await t.exception(() => B.request('space:join', { inviteCode: invite }), /expired/i, 'join is refused with an expired error')
  t.absent((await B.request('spaces:list')).some((s) => s.spaceId === space.spaceId), 'expired link does not create a pending space')
})

// REGRESSION (FIX-2, R1): the per-link record is replicated, so a co-member enforces an auto-approve
// link the MINTER never resolves. A mints the link and goes offline; C (a member who learned the
// record via replication) auto-admits B with no manual approval.
test('REGRESSION (FIX-2): a co-member enforces an auto-approve link the offline minter did not resolve', { timeout: 300000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const mk = (name) => launchPeer(t, { bootstrap, displayName: name, storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const A = await mk('Alice'); const B = await mk('Bob'); const C = await mk('Carol')
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey

  const space = await A.request('space:create', { name: 'Trio' })
  const spaceId = space.spaceId
  const invite = await A.request('space:invite', { spaceId, autoAdmit: true })

  // C joins via the auto link → A (online, the minter) admits C. C now replicates A's profile bee,
  // including the invite record.
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === spaceId)
  await C.request('space:join', { inviteCode: invite })
  await cGranted
  await C.until('spaces:list', {}, (l) => (l.find((s) => s.spaceId === spaceId)?.members || [])
    .some((m) => m.publicKey === aKey), { ms: 60000, every: 1000 })
  await new Promise((r) => setTimeout(r, 6000)) // let C fully replicate A's profile core (incl. the record)

  // The minter goes offline. Only C can resolve B's join now.
  A.kill()
  let cPrompted = false
  C.on('event:member-join-request', () => { cPrompted = true })

  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId)
  await B.request('space:join', { inviteCode: invite })
  await bGranted
  await B.until('spaces:list', {}, (l) => l.find((s) => s.spaceId === spaceId)?.status !== 'pending', { ms: 60000, every: 1000 })
  await C.until('spaces:list', {}, (l) => (l.find((s) => s.spaceId === spaceId)?.members || []).some((m) => m.publicKey === bKey), { ms: 60000, every: 1000 })

  t.absent((await status(B, spaceId)) === 'pending', 'B is no longer pending — auto-admitted by C')
  t.absent(cPrompted, 'C auto-admitted B from the replicated record — no manual prompt')
  t.ok((await memberKeys(C, spaceId)).has(bKey), 'C (the resolver) admitted B as a member')
})
