import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const v2flags = (kek) => ({ identityKEK: kek, membershipApprovalEnabled: true })
const hasMember = (sid, key) => (list) => {
  const s = list.find((x) => x.spaceId === sid)
  return !!(s && (s.members || []).some((m) => m.publicKey === key))
}

async function membersWithOfflineB (t) {
  const bootstrap = await localTestnet(t)
  const aStorage = path.join(mkTmpDir(t), 'app-storage')
  const bStorage = path.join(mkTmpDir(t), 'app-storage')
  const aDownloads = mkTmpDir(t)
  const bDownloads = mkTmpDir(t)
  const aKek = kekHex()
  const bKek = kekHex()
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStorage, downloads: aDownloads, flags: v2flags(aKek) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads, flags: v2flags(bKek) })
  const sid = await connectInSpaceWithApproval(t, A, B, 'Alone')
  const aKey = (await A.request('profile:get')).publicKey

  const bPid = B.sidecar?._process?.pid
  B.kill()
  if (bPid) await waitForWorkerExit(bPid, 5000)
  // Let Alice's socket to the dead peer close so the leave really happens "alone".
  await new Promise((r) => setTimeout(r, scaled(3000)))

  return {
    A, sid, aKey,
    relaunchA: () => launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStorage, downloads: aDownloads, flags: v2flags(aKek) }),
    relaunchB: () => launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads, flags: v2flags(bKek) }),
  }
}

// Companion coverage for FIX-E1 (the strict red-first pin is the restart test below —
// while the leaver stays online, a returning co-member can also converge by dialing the
// recently-seen peer and replicating its live profile bee's del record): the same-session
// path must converge deterministically via the re-announced leave frame, not by luck.
test('a leave performed while alone reaches a co-member returning the same session',
  { timeout: scaled(300000) }, async (t) => {
    const { A, sid, aKey, relaunchB } = await membersWithOfflineB(t)

    await A.request('space:leave', { spaceId: sid })
    t.absent((await A.request('spaces:list', {})).some((s) => s.spaceId === sid), 'Alice dropped the space locally')

    const B = await relaunchB()
    t.ok(await B.until('spaces:list', {}, (l) => l.some((x) => x.spaceId === sid), { ms: 30000 }).then(() => true),
      'Bob still holds the space')

    await B.until('spaces:list', {}, (l) => !hasMember(sid, aKey)(l), { ms: 120000 })
    t.pass("Bob dropped Alice — the replayed leave frame reached him without Alice restarting")

    await new Promise((r) => setTimeout(r, scaled(4000)))
    t.absent(hasMember(sid, aKey)(await B.request('spaces:list', {})), 'Alice stays removed (no fold resurrection)')

    A.kill()
  })

// BUG (audit P3): a leave broadcast while no co-member is connected reaches nobody; the
// durable departure (del member/<S>) lives only in the leaver's bee, and once the leaver
// restarts it no longer joins the left space's topic — a returning co-member can never
// find it, re-reads the stale active record from cache, and keeps the leaver as a ghost
// member FOREVER. The marker makes boot re-join the topic and replay the leave frame.
test('REGRESSION (FIX-E1: the pending leave replays across the leaver restart)',
  { timeout: scaled(300000) }, async (t) => {
    const first = await membersWithOfflineB(t)
    const { sid, aKey } = first

    await first.A.request('space:leave', { spaceId: sid })
    const aPid = first.A.sidecar?._process?.pid
    first.A.kill()
    if (aPid) await waitForWorkerExit(aPid, 5000)

    const B = await first.relaunchB()
    const A2 = await first.relaunchA()

    await B.until('spaces:list', {}, (l) => !hasMember(sid, aKey)(l), { ms: 120000 })
    t.pass('the boot replay delivered the leave to Bob')
    t.absent((await A2.request('spaces:list', {})).some((s) => s.spaceId === sid), "Alice's restart did not resurrect the space")

    A2.kill()
  })
