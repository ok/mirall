import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')

// BUG (audit P6): deny writes the durable denied/<S>/<joiner> tombstone (converges among
// members) but signals the joiner only via the live deny frame — and onDeny is the sole
// thing that discards the joiner's stranded pending space. Deny-while-offline left the
// joiner stuck "waiting for approval" forever, silently re-knocking on every reconnect.
// The fix re-sends the deny to a re-knocking joiner whose fold state is denied-and-not-
// pending, without resurfacing an approval banner.
test('REGRESSION (FIX-C2: a joiner denied while offline gets the deny on reconnect)',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const bStorage = path.join(mkTmpDir(t), 'app-storage')
    const bDownloads = mkTmpDir(t)
    const bKek = kekHex()
    const A = await launchPeer(t, {
      bootstrap, displayName: 'Alice', storage: path.join(mkTmpDir(t), 'app-storage'), downloads: mkTmpDir(t),
      flags: { identityKEK: kekHex(), membershipApprovalEnabled: true },
    })
    let B = await launchPeer(t, {
      bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads,
      flags: { identityKEK: bKek, membershipApprovalEnabled: true },
    })

    const space = await A.request('space:create', { name: 'Gated' })
    const sid = space.spaceId
    const inviteCode = await A.request('space:invite', { spaceId: sid })
    const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === sid)
    await B.request('space:join', { inviteCode })
    const req = await aGotRequest

    const bPid = B.sidecar?._process?.pid
    B.kill()
    if (bPid) await waitForWorkerExit(bPid, 5000)

    t.ok(await A.request('space:deny-member', { spaceId: sid, publicKey: req.publicKey }),
      'denial recorded while the joiner is offline')

    let freshBanner = false
    A.on('event:member-join-request', (m) => { if (m.spaceId === sid) freshBanner = true })

    B = await launchPeer(t, {
      bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads,
      flags: { identityKEK: bKek, membershipApprovalEnabled: true },
    })
    await B.waitFor('event:membership-denied', (m) => m.spaceId === sid, 120000)
    t.pass('the reconnect knock earned the re-sent deny')

    await B.until('spaces:list', {}, (l) => !l.some((x) => x.spaceId === sid), { ms: 60000 })
    t.pass('Bob discarded the stranded pending space')

    await new Promise((r) => setTimeout(r, scaled(4000)))
    t.absent(freshBanner, 'the re-sent deny resurfaced NO fresh approval banner on Alice')
    t.absent((await A.request('space:pending-requests', { spaceId: sid })).some((r) => r.publicKey === req.publicKey),
      'no pending request lingers for the denied joiner')

    A.kill()
  })

// REGRESSION (FIX-C2 lockout): the re-deny must not permanently ban a joiner. Once the deny is
// delivered and the joiner discards, a FRESH review invite (a deliberate re-invitation by the
// owner) must resurface the approval banner — not be silently re-denied against the persistent
// denied/<S>/<joiner> tombstone.
test('REGRESSION (FIX-C2: a fresh review invite re-opens the door after a denial)',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const bStorage = path.join(mkTmpDir(t), 'app-storage')
    const bDownloads = mkTmpDir(t)
    const bKek = kekHex()
    const A = await launchPeer(t, {
      bootstrap, displayName: 'Alice', storage: path.join(mkTmpDir(t), 'app-storage'), downloads: mkTmpDir(t),
      flags: { identityKEK: kekHex(), membershipApprovalEnabled: true },
    })
    const B = await launchPeer(t, {
      bootstrap, displayName: 'Bob', storage: bStorage, downloads: bDownloads,
      flags: { identityKEK: bKek, membershipApprovalEnabled: true },
    })

    const space = await A.request('space:create', { name: 'Reopen' })
    const sid = space.spaceId
    const firstInvite = await A.request('space:invite', { spaceId: sid })
    const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === sid)
    const bDenied = B.waitFor('event:membership-denied', (m) => m.spaceId === sid, 120000)
    await B.request('space:join', { inviteCode: firstInvite })
    const req = await aGotRequest

    // A denies B (B online here), B discards its pending space.
    await A.request('space:deny-member', { spaceId: sid, publicKey: req.publicKey })
    await bDenied
    await B.until('spaces:list', {}, (l) => !l.some((x) => x.spaceId === sid), { ms: 60000 })

    // A changes their mind: mint a FRESH review invite (expiry → a durable per-link record,
    // autoApprove off) and send it to B.
    const reviewInvite = await A.request('space:invite', { spaceId: sid, expiresInMs: scaled(3600000) })
    const aGotSecond = A.waitFor('event:member-join-request', (m) => m.spaceId === sid && m.publicKey === req.publicKey, 120000)
    await B.request('space:join', { inviteCode: reviewInvite })
    await aGotSecond
    t.pass('the fresh review invite resurfaced the approval banner — no silent lockout')

    // The joiner is now an approvable pending request again (the durable denial no longer
    // masks them). The grant-delivery convergence itself is covered by the membership suite;
    // the load-bearing fix here is that the door re-opened at all.
    t.ok((await A.request('space:pending-requests', { spaceId: sid })).some((r) => r.publicKey === req.publicKey),
      'B is re-listed as an approvable request, not silently locked out')

    A.kill()
  })
