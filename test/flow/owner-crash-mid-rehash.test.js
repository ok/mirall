import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// The owner dies BETWEEN the two appends of a re-publish — advertise(contentHash:null) and
// setMaterializedHash — so the null-hash entry is left in its catalog (no revert runs on a kill).
// The receiver's download must survive that:
//
//   1. it must NOT be dropped or errored (the doomed old-hash fetch is expected to fail — the
//      owner overwrote the source out from under it),
//   2. it parks NON-terminally as 'preparing' (a null-hash owner head, no active fetch), so
//   3. when the owner returns and its boot rehydration re-hashes the source, the download resumes
//      BY ITSELF on the new content — no user action.
//
// Scope note: this is a recovery/backstop test, not the regression guard for the null-window drop.
// A SIGKILL'd owner cannot serve its catalog head, so the receiver never *reads* the null window
// here and the old code survives this timing too. The drop itself is pinned deterministically at
// the integration layer (overlay-download-republish.test.js, which fakes the head) and, for an
// active transfer, by loose-source-change-restart — both of which are red without the fix.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const flags = (kek) => ({
  overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true,
  sharePrepareProgressEnabled: true, identityKEK: kek,
})
const statusOf = (list, p) => list.find((e) => e.path === p)?.status

test('owner killed mid-rehash: the download parks instead of dying, and resumes when the owner returns',
  { timeout: scaled(300000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const aStore = idStore(t)
    const aKek = kekHex()
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: flags(aKek) })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags(kekHex()) })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const original = patternedBytes(24 * 1024 * 1024, 51)
    const srcPath = path.join(aSrc, 'big.bin')
    fs.writeFileSync(srcPath, original)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: original.length })
    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/big.bin' && e.status === 'remote'), { ms: 60000 })

    let sawError = null
    let removed = false
    B.on('event:transfer-error', (m) => { if (m.path === '/big.bin') sawError = m.errorCode })
    B.on('event:transfer-removed', (m) => { if (m.path === '/big.bin') removed = true })

    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/big.bin' && m.bytes > 0) resolve() })
    })
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    await flowing

    // Re-publish a CHANGED source, then kill A the moment it starts hashing. The 'preparing'
    // decoration is A's own hashing-progress frame: it proves the first append (null hash) landed
    // and A is mid-hash, so the kill lands exactly inside the window this test is about.
    const changed = patternedBytes(20 * 1024 * 1024, 93)
    const preparing = B.waitFor('event:decoration', (m) => m.key === '/big.bin' && m.phase === 'preparing', 60000)
    fs.writeFileSync(srcPath, changed)
    A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: changed.length }).catch(() => {})
    await preparing
    A.kill() // SIGKILL mid-hash: no revert runs, the null-hash entry stays in A's catalog

    // Give the receiver time to observe the null-hash head and park non-terminally.
    await new Promise((r) => setTimeout(r, scaled(9000)))

    t.absent(sawError, 'no misleading transfer-error — the doomed old-hash fetch is expected to fail')
    t.absent(removed, 'the download intent is NOT torn down (the drop is the bug this fixes)')
    const parked = await B.request('files:list', { spaceId })
    t.absent(statusOf(parked, '/big.bin') === 'downloaded', 'nothing landed — the owner never finished publishing')
    t.ok(fs.existsSync(path.join(B.downloads, 'big.bin')) === false, 'no orphan final file')

    // A returns. Boot rehydration re-hashes the changed source and appends the real hash — the
    // second append the receiver has been waiting for all along.
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/big.bin', 240000)
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: flags(aKek) })

    const completion = await done
    const landed = fs.readFileSync(completion.localPath)
    t.is(sha(landed), sha(changed), 'the parked download resumed BY ITSELF and landed the NEW content byte-exact')
    t.is(landed.length, changed.length, 'full size of the changed source')
    t.absent(completion.localPath.endsWith('.mirall.part'), 'finalised, not a partial')
    t.absent(sawError, 'still no transfer-error across the whole recovery')

    A.kill()
  })
