import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const statusOf = (f, p) => (Array.isArray(f) ? f.find((e) => e.path === p)?.status : undefined)

// REGRESSION (FIX-REMOVE-1): the owner REMOVES a loose file mid-download, then RE-ADDS the same
// content. The receiver must NOT auto-resume — the deliberate removal terminates the intent
// (partial discarded, row cleared → 'remote'); the re-add requires an explicit manual download.
// Contrast loose-source-change-restart (a content CHANGE auto-restarts) and
// seeder-quit-mid-download (a transient owner-offline auto-resumes) — removal is the deliberate
// case in between.
test('owner remove + re-add mid-download does NOT auto-resume; requires a manual re-download',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    // Big enough that B is comfortably mid-transfer when A removes the file.
    const bytes = patternedBytes(24 * 1024 * 1024, 47)
    const srcPath = path.join(aSrc, 'big.bin')
    fs.writeFileSync(srcPath, bytes)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: bytes.length })
    await B.until('files:list', { spaceId }, (f) => statusOf(f, '/big.bin') === 'remote', { ms: scaled(60000) })

    let removed = false
    let completedBeforeRemove = false
    let autoCompleted = false
    let manualStarted = false
    B.on('event:transfer-complete', (m) => {
      if (m.path !== '/big.bin') return
      if (!removed) completedBeforeRemove = true
      else if (!manualStarted) autoCompleted = true
    })

    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/big.bin' && m.bytes > 0) resolve() })
    })
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    await flowing

    // Arm the removal-signal listener BEFORE the remove so the worker's event:transfer-removed
    // (which drives the mandatory toast, and proves the intent row was torn down) can't race us.
    const removedSignal = B.waitFor('event:transfer-removed', (m) => m.path === '/big.bin', scaled(60000))
    await A.request('files:remove', { spaceId, path: '/big.bin' })
    removed = true
    t.absent(completedBeforeRemove, 'the original did not complete before the removal (mid-transfer path exercised)')

    t.is((await removedSignal).fileName, 'big.bin', 'worker emitted event:transfer-removed for the torn-down download')

    // B observes the removal: the file leaves B's listing (tombstone hides it).
    await B.until('files:list', { spaceId }, (f) => !Array.isArray(f) || !f.some((e) => e.path === '/big.bin'), { ms: scaled(60000) })

    // A re-adds the SAME content (human-paced: after B saw the removal → distinct appends).
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: bytes.length })

    // The file returns for B as 'remote' — NOT downloading/paused/downloaded — and STAYS so.
    await B.until('files:list', { spaceId }, (f) => statusOf(f, '/big.bin') === 'remote', { ms: scaled(60000) })
    await new Promise((r) => setTimeout(r, scaled(8000))) // stability window: the buggy auto-resume would fire here
    const stable = await B.request('files:list', { spaceId })
    t.is(statusOf(stable, '/big.bin'), 'remote', 'file remains "remote" after re-add — intent terminated, no auto-resume')
    t.absent(autoCompleted, 'no auto-resume completion fired without a manual re-download')

    // A manual re-download works and lands the bytes.
    manualStarted = true
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/big.bin', scaled(120000))
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    const completion = await done
    t.is(sha(fs.readFileSync(completion.localPath)), sha(bytes), 'manual re-download landed the content byte-exact')

    A.kill()
  })
