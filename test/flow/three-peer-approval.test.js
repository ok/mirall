import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// Repro for the reported 3-peer regression: owner A invites B and C; A approves B; C stays
// waiting. Symptoms to catch: (D) B hangs in "waiting for approval"; (C) a co-member B lists
// the unapproved C as a member; (B) B does not see C as a pending request.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')

const status = async (peer, spaceId) =>
  (await peer.request('spaces:list')).find((s) => s.spaceId === spaceId)?.status
const memberKeys = async (peer, spaceId) => {
  const s = (await peer.request('spaces:list')).find((x) => x.spaceId === spaceId)
  return new Set((s?.members || []).map((m) => m.publicKey))
}
const pendingKeys = async (peer, spaceId) =>
  new Set((await peer.request('space:pending-requests', { spaceId })).map((r) => r.publicKey))

async function runScenario (t, flags) {
  const bootstrap = await localTestnet(t)
  const mk = (name) => launchPeer(t, { bootstrap, displayName: name, storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const A = await mk('Alice'); const B = await mk('Bob'); const C = await mk('Carol')

  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey

  const space = await A.request('space:create', { name: 'Trio' })
  const spaceId = space.spaceId
  const invite = await A.request('space:invite', { spaceId })

  const aGotB = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aGotB
  const aGotC = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === cKey)
  await C.request('space:join', { inviteCode: invite })
  await aGotC

  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId)
  await A.request('space:approve-member', { spaceId, publicKey: bKey })
  await bGranted   // SYMPTOM D: times out here if B's grant never lands.

  await new Promise((r) => setTimeout(r, 6000))

  t.ok((await memberKeys(B, spaceId)).has(aKey), 'B sees A as a member')
  t.absent((await memberKeys(B, spaceId)).has(cKey), 'SYMPTOM C: B must NOT list the unapproved C as a member')
  t.ok((await pendingKeys(B, spaceId)).has(cKey), 'SYMPTOM B: B sees C as a pending join request')
  t.is(await status(C, spaceId), 'pending', 'C is still waiting for approval')
}

test('3-peer approval — binding ON + identity (shipped config)', { timeout: 300000 }, async (t) => {
  await runScenario(t, () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true }))
})

test('3-peer approval — binding OFF + identity', { timeout: 300000 }, async (t) => {
  await runScenario(t, () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: false }))
})

// REGRESSION: a co-member B approves a joiner C it learned about via REPLICATION (the fold over
// the owner's request record), not a direct request banner. To seal the grant, B must recover C's
// bound signer key from C's live connection (boundSignerKeys) — C is connected to B in the mesh —
// rather than from the request-record copy; else B's approval silently fails and C hangs forever.
test('3-peer: a co-member can approve a joiner learned via replication', { timeout: 300000 }, async (t) => {
  const flags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true })
  const bootstrap = await localTestnet(t)
  const mk = (name) => launchPeer(t, { bootstrap, displayName: name, storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const A = await mk('Alice'); const B = await mk('Bob'); const C = await mk('Carol')
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey

  const space = await A.request('space:create', { name: 'Trio' })
  const spaceId = space.spaceId
  const invite = await A.request('space:invite', { spaceId })

  // B and C both join while neither is approved — so B (pending) ignores C's direct request and
  // only ever learns of C from the owner's replicated receipt.
  const aGotB = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aGotB
  const aGotC = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === cKey)
  await C.request('space:join', { inviteCode: invite })
  await aGotC

  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId)
  await A.request('space:approve-member', { spaceId, publicKey: bKey })
  await bGranted

  // B now sees C as pending purely from the fold. B approves C — C must converge.
  await B.until('space:pending-requests', { spaceId }, (r) => r.some((x) => x.publicKey === cKey), { ms: 30000 })
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === spaceId)
  await B.request('space:approve-member', { spaceId, publicKey: cKey })
  await cGranted   // B must seal the grant from C's live-connection signer key, not the request record.

  await C.until('spaces:list', {}, (l) => l.find((s) => s.spaceId === spaceId)?.status !== 'pending', { ms: 30000 })
  t.absent((await status(C, spaceId)) === 'pending', 'C is no longer waiting for approval (converged)')

  // C must converge the full roster, not re-file the existing members as pending (a handshaker
  // always holds a drive ⇒ is already an approved member, never a fresh join request).
  await C.until('spaces:list', {}, (l) => {
    const m = new Set((l.find((s) => s.spaceId === spaceId)?.members || []).map((x) => x.publicKey))
    return m.has(aKey) && m.has(bKey)
  }, { ms: 30000 })
  const cMembers = await memberKeys(C, spaceId)
  t.ok(cMembers.has(aKey), 'C sees A (owner) as a member')
  t.ok(cMembers.has(bKey), 'C sees B (its approver) as a member')
  t.absent((await pendingKeys(C, spaceId)).has(bKey), 'C does NOT see B (a member) as waiting for approval')
  t.absent((await pendingKeys(C, spaceId)).has(aKey), 'C does NOT see A (a member) as waiting for approval')
})
