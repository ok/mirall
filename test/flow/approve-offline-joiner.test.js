import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const v2flags = (kek) => ({ identityKEK: kek })
const hasMember = (sid, key) => (list) => {
  const s = list.find((x) => x.spaceId === sid)
  return !!(s && (s.members || []).some((m) => m.publicKey === key))
}

async function knockThenGoOffline (t, { expiresInMs } = {}) {
  const bootstrap = await localTestnet(t)
  const bStorage = path.join(mkTmpDir(t), 'app-storage')
  const bDownloads = mkTmpDir(t)
  const bKek = kekHex()
  const A = await launchPeer(t, {
    bootstrap, displayName: 'Alice', storage: path.join(mkTmpDir(t), 'app-storage'), downloads: mkTmpDir(t),
    flags: v2flags(kekHex()),
  })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads, flags: v2flags(bKek) })

  const space = await A.request('space:create', { name: 'Secure' })
  const sid = space.spaceId
  const inviteCode = await A.request('space:invite', { spaceId: sid, ...(expiresInMs ? { expiresInMs } : {}) })
  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === sid)
  await B.request('space:join', { inviteCode })
  const req = await aGotRequest

  const bPid = B.sidecar?._process?.pid
  B.kill()
  if (bPid) await waitForWorkerExit(bPid, 5000)
  // Let Alice's socket to the dead peer tear down before she acts on the request.
  await new Promise((r) => setTimeout(r, scaled(2000)))

  const relaunchB = () => launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads, flags: v2flags(bKek) })
  return { A, sid, joinerKey: req.publicKey, relaunchB }
}

// Audit P1: approval writes the durable approved/<S>/<joiner> receipt but delivers the SCK
// only as a live frame, so an approve-while-offline strands the joiner on "waiting for
// approval" until replication + the derived-member readmit loop happen to converge it. The
// re-grant off the durable receipt closes that on the joiner's first reconnect knock.
test('a joiner approved while offline converges on reconnect', { timeout: scaled(240000) }, async (t) => {
  const { A, sid, joinerKey, relaunchB } = await knockThenGoOffline(t)

  const res = await A.request('space:approve-member', { spaceId: sid, publicKey: joinerKey })
  t.ok(res.granted, 'approval recorded while the joiner is offline')
  console.log('approve-offline-joiner: grant frame claimed delivered =', !!res.delivered)

  const B = await relaunchB()
  await B.waitFor('event:membership-granted', (m) => m.spaceId === sid, 120000)
  t.pass('the reconnect knock earned a re-issued grant')

  await B.until('spaces:list', {}, (l) => {
    const s = l.find((x) => x.spaceId === sid)
    return !!s && s.status !== 'pending'
  }, { ms: 60000 })
  t.pass("Bob's space left 'pending'")

  await A.until('spaces:list', {}, hasMember(sid, joinerKey), { ms: 60000 })
  t.pass("Alice's fold promoted Bob to a member")

  A.kill()
})

// The load-bearing ordering: the re-grant must run BEFORE the invite classification. The
// joiner's automatic reconnect knock still carries its original inviteId — if that link
// expired while the joiner was offline (after its approval), the 'expired' branch answered
// the knock with a DENY, making the approved joiner silently discard the space it was
// admitted to. The durable approval receipt outranks the spent invite.
test('REGRESSION (FIX-C1: an approved joiner is not re-denied by its since-expired invite)',
  { timeout: scaled(240000) }, async (t) => {
    const { A, sid, joinerKey, relaunchB } = await knockThenGoOffline(t, { expiresInMs: scaled(3000) })

    const res = await A.request('space:approve-member', { spaceId: sid, publicKey: joinerKey })
    t.ok(res.granted, 'approval recorded while the joiner is offline')

    // Outlive the invite so the reconnect knock resolves it as 'expired'.
    await new Promise((r) => setTimeout(r, scaled(4000)))

    const B = await relaunchB()
    let denied = false
    B.on('event:membership-denied', (m) => { if (m.spaceId === sid) denied = true })

    await B.waitFor('event:membership-granted', (m) => m.spaceId === sid, 120000)
    t.pass('approved joiner re-granted despite the expired invite')
    t.absent(denied, 'no deny answered the approved joiner\'s knock')

    await B.until('spaces:list', {}, (l) => {
      const s = l.find((x) => x.spaceId === sid)
      return !!s && s.status !== 'pending'
    }, { ms: 60000 })
    t.ok((await B.request('spaces:list', {})).some((s) => s.spaceId === sid), 'the space was not discarded')

    A.kill()
  })
