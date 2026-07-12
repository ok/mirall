import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// The over-eager-teardown guard for the leave fix (FIX-3). Leaving a space now drops the content
// sockets of peers we no longer share ANY space with — because the overlay content channel rides
// the content socket, and hyperswarm's leave() only un-announces the topic, it never closes a live
// connection. The rule keys on "this peer is left in no spaces", the same rule the control plane
// already used. Get it wrong in the other direction and a leave kills a healthy transfer with a
// peer we still share another space with, which no other test would catch.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

test('leaving one shared space does not disturb an in-flight transfer in another',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

    // TWO shared spaces. A leaves the first; the transfer lives in the second.
    const leftSpace = await connectInSpaceWithApproval(t, A, B, 'Space To Leave')
    const keptSpace = await connectInSpaceWithApproval(t, A, B, 'Space To Keep')
    const aKey = (await A.request('profile:get')).publicKey

    const bytes = patternedBytes(32 * 1024 * 1024, 71)
    fs.writeFileSync(path.join(aSrc, 'keep.bin'), bytes)
    await A.request('files:add', { spaceId: keptSpace, filePath: path.join(aSrc, 'keep.bin'), fileName: 'keep.bin', fileSize: bytes.length })
    await B.until('files:list', { spaceId: keptSpace },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/keep.bin' && e.status === 'remote'), { ms: 60000 })

    let sawError = null
    B.on('event:transfer-error', (m) => { if (m.path === '/keep.bin') sawError = m.errorCode })
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/keep.bin', 180000)

    // Get real bytes moving on the content plane before the leave lands.
    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === keptSpace && m.key === '/keep.bin' && m.bytes > 0) resolve() })
    })
    await B.request('files:download', { spaceId: keptSpace, path: '/keep.bin', inPlace: true, ownerKey: aKey })
    await flowing

    await A.request('space:leave', { spaceId: leftSpace })

    // The peers still share keptSpace, so the content socket must SURVIVE and keep serving.
    const completion = await done
    const landed = fs.readFileSync(completion.localPath)
    t.is(sha(landed), sha(bytes), 'the other space\'s transfer completed byte-exact across the leave')
    t.is(landed.length, bytes.length, 'and is the full file — the content socket was not torn down')
    t.absent(sawError, 'no transfer-error: leaving one space does not break the other')

    const aSpaces = await A.request('spaces:list', {})
    t.absent(aSpaces.some((s) => s.spaceId === leftSpace), 'the left space is gone')
    t.ok(aSpaces.some((s) => s.spaceId === keptSpace), 'the kept space remains')

    A.kill()
  })
