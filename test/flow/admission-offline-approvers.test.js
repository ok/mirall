import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A functional guard: with the creator offline, a joiner approved by one co-member is admitted by
// another co-member, whose gate answers from its own record, the fold, or the other members' bees.
// The gate's timing is pinned red-first in test/integration/admission-gates.test.js, not here: an
// offline member's bee is already replicated in this harness, so its read answers from local blocks
// under the old serial gate too.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const hasMember = (l, spaceId, key) =>
  ((l.find((s) => s.spaceId === spaceId)?.members) || []).some((m) => m.publicKey === key)

test('a co-member admits a joiner approved by another member while the creator is offline', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const flags = () => ({
    identityKEK: kekHex(),
    handshakeIdentityBindingEnabled: true,
  })
  const mk = (name) => launchPeer(t, { bootstrap, displayName: name, storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const A = await mk('Alice'); const B = await mk('Bob'); const C = await mk('Carol')
  const bKey = (await B.request('profile:get')).personKey
  const cKey = (await C.request('profile:get')).personKey

  const space = await A.request('space:create', { name: 'Quartet' })
  const spaceId = space.spaceId
  const invite = await A.request('space:invite', { spaceId })
  for (const [peer, key] of [[B, bKey], [C, cKey]]) {
    const knocked = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === key, 120000)
    await peer.request('space:join', { inviteCode: invite })
    await knocked
    const granted = peer.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
    await A.request('space:approve-member', { spaceId, publicKey: key })
    await granted
  }
  await B.until('spaces:list', {}, (l) => hasMember(l, spaceId, cKey), { ms: 60000, every: 1000 })
  await C.until('spaces:list', {}, (l) => hasMember(l, spaceId, bKey), { ms: 60000, every: 1000 })

  const aPid = A.sidecar?._process?.pid
  A.kill()
  if (aPid) await waitForWorkerExit(aPid, 8000)

  const D = await mk('Dave')
  const dKey = (await D.request('profile:get')).personKey
  const cInvite = await C.request('space:invite', { spaceId })
  const cGotD = C.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === dKey, 120000)
  await D.request('space:join', { inviteCode: cInvite })
  await cGotD

  const bAdmitsD = B.waitFor('event:member-joined', (m) => m.spaceId === spaceId && m.member?.publicKey === dKey, 120000)
  const dGranted = D.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await C.request('space:approve-member', { spaceId, publicKey: dKey })
  await dGranted
  await bAdmitsD
  t.pass('B admitted D while the creator was offline')

  await B.until('spaces:list', {}, (l) => hasMember(l, spaceId, dKey), { ms: 60000, every: 1000 })
  t.pass("D converged into B's roster")
})
