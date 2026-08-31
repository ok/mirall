import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// Loose PUBLISH lifecycle over two peers: cancelling a publish while it is still indexing
// (contentHash null), and re-sharing a file after it was unshared. Both were integration-only
// (single peer) / uncovered — these prove the peer-visible outcome: a cancelled publish never
// becomes a real share for the peer, and a re-added file re-appears and downloads cleanly (no
// stuck tombstone). FE s85/s100.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex() })
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

// B1 — owner cancels the publish while still indexing.
test('owner cancels publish while indexing: the peer never sees the half-advertised entry',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)

    // Big enough that indexing takes a catchable moment.
    const bytes = patternedBytes(128 * 1024 * 1024, 3)
    fs.writeFileSync(path.join(aSrc, 'huge.bin'), bytes)
    A.request('files:add', { spaceId, filePath: path.join(aSrc, 'huge.bin'), fileName: 'huge.bin', fileSize: bytes.length }).catch(() => {})

    // Catch the still-indexing 'publishing' row, then cancel the publish.
    await A.until('files:list', { spaceId }, (list) => Array.isArray(list) && list.some((e) => e.path === '/huge.bin' && e.status === 'publishing'), { ms: 30000 })
    await A.request('files:cancel-publish', { spaceId, path: '/huge.bin' })
    await A.until('files:list', { spaceId }, (list) => !Array.isArray(list) || !list.some((e) => e.path === '/huge.bin'), { ms: 30000 })

    // The peer must never observe it as an available (remote) share; any transient preparing row clears.
    await sleep(8000)
    const bRow = (await B.request('files:list', { spaceId })).find((e) => e.path === '/huge.bin')
    t.comment(`peer end-state for cancelled publish: ${bRow ? 'status=' + bRow.status : 'absent'}`)
    t.ok(!bRow || bRow.status !== 'remote', 'peer never sees the cancelled publish as available')
    A.kill()
  })

// G1 — reshare a loose file after unshare.
test('loose reshare after unshare: the file can be added again and downloads cleanly',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const bytes = patternedBytes(2 * 1024 * 1024, 61)
    const src = path.join(aSrc, 'cycle.bin')
    fs.writeFileSync(src, bytes)
    await A.request('files:add', { spaceId, filePath: src, fileName: 'cycle.bin', fileSize: bytes.length })
    await B.until('files:list', { spaceId }, (f) => f.some((e) => e.path === '/cycle.bin' && e.status === 'remote'), { ms: 60000 })

    // Unshare → it disappears for the peer.
    await A.request('files:remove', { spaceId, path: '/cycle.bin' })
    await B.until('files:list', { spaceId }, (f) => !f.some((e) => e.path === '/cycle.bin'), { ms: 60000 })

    // Re-add the same file; capture whatever path it re-shares under (tombstone must not block it).
    await A.request('files:add', { spaceId, filePath: src, fileName: 'cycle.bin', fileSize: bytes.length })
    const reAdded = await A.until('files:list', { spaceId }, (list) => Array.isArray(list) && list.some((e) => e.path.includes('cycle') && e.status === 'mine'), { ms: 30000 })
    const rePath = reAdded.find((e) => e.path.includes('cycle') && e.status === 'mine').path
    t.comment(`re-shared under path: ${rePath}`)

    // The peer sees it again and can download it.
    await B.until('files:list', { spaceId }, (f) => f.some((e) => e.path === rePath && e.status === 'remote'), { ms: 60000 })
    const done = B.waitFor('event:transfer-complete', (m) => m.path === rePath, 120000)
    await B.request('files:download', { spaceId, path: rePath, inPlace: true, ownerKey: aKey })
    const completion = await done
    t.ok(fs.readFileSync(completion.localPath).equals(bytes), 're-shared file downloads byte-exact')
    A.kill()
  })
