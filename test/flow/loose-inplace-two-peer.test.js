import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// In-place loose files end-to-end: the owner's REAL file on disk is the source —
// nothing is copied into app storage. A member sees it in the flat file list (from the
// replicated loose catalog) and fetches by content hash over the overlay channel.
// Loose discovery resolves the owner's looseCatalogKey from two channels (like the participation id):
// the live handshake and the profile bee (folded via member-registry).
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex() })

test('in-place loose file: owner shares with no drive copy; member fetches by content hash',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).personKey

    // Alice shares an arbitrary file on disk (no mount, no folder) straight into the space.
    const baseline = await A.request('storage:info')
    const bytes = patternedBytes(256 * 1024, 7)
    const srcPath = path.join(mkTmpDir(t), 'big.bin')
    fs.writeFileSync(srcPath, bytes)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: bytes.length })

    // No second copy: the share never imports bytes into app storage.
    const before = await A.request('storage:info')
    t.ok(before.totalDiskUsage - baseline.totalDiskUsage < bytes.length / 2, 'no import — served in place')

    // Bob sees it in the flat list (from Alice's replicated loose catalog), marked in-place + remote.
    const listed = await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/big.bin' && e.inPlace && e.status === 'remote'),
      { ms: 60000 })
    const entry = listed.find((e) => e.path === '/big.bin')
    t.is(entry.size, bytes.length, 'catalog carries the size')
    t.ok(entry.hash, 'catalog carries the content hash')

    // Bob fetches by content hash straight from Alice; completion arrives via event.
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/big.bin', 60000)
    const res = await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    t.ok(res?.transferId, 'in-place download returned a transferId (non-blocking)')
    const completed = await done
    t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'downloaded bytes match the source')

    // Bob's row now shows downloaded + verified (the overlay checked the whole-file
    // hash byte-for-byte during the transfer).
    const bobList = await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/big.bin' && e.status === 'downloaded'),
      { ms: 30000 })
    t.is(bobList.find((e) => e.path === '/big.bin')?.verified, true, 'downloaded loose file shows the verified badge')

    // Still no copy on Alice after serving — the fetch streamed from the source file.
    const after = await A.request('storage:info')
    t.ok(after.totalDiskUsage - baseline.totalDiskUsage < bytes.length / 2, 'still no copy after serving')
  })

test('in-place loose file is unavailable while the owner is offline',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).personKey

    const bytes = patternedBytes(16 * 1024, 4)
    const srcPath = path.join(mkTmpDir(t), 'note.txt')
    fs.writeFileSync(srcPath, bytes)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'note.txt', fileSize: bytes.length })

    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/note.txt' && e.status === 'remote'),
      { ms: 60000 })

    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })

    const files = await B.request('files:list', { spaceId })
    t.is(files.find((e) => e.path === '/note.txt')?.status, 'unavailable', 'unavailable with the owner offline')

    const res = await B.request('files:download', { spaceId, path: '/note.txt', inPlace: true, ownerKey: aKey })
    t.ok(res && res.queued, 'download queues (no holder online), no hang')
  })

// Bob's listing memo holds Alice's catalog across her absence, and his backstop is off, so the only
// thing that can surface what she publishes on her return is her catalog's version moving on his
// side. Every file of a burst must land, not just the first poke's worth.
test('files an owner publishes on returning are all listed, with the listing backstop off',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = idStore(t)
    const aFlags = v2flags()
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: mkTmpDir(t), flags: aFlags })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: { ...v2flags(), listFullReadEvery: 1_000_000 } })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).personKey
    const src = mkTmpDir(t)

    const add = async (name) => {
      fs.writeFileSync(path.join(src, name), name)
      await A.request('files:add', { spaceId, filePath: path.join(src, name), fileName: name, fileSize: name.length })
    }
    await add('first.txt')
    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/first.txt' && e.status === 'remote'), { ms: 60000 })

    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })
    const away = await B.request('files:list', { spaceId })
    t.is(away.find((e) => e.path === '/first.txt')?.status, 'unavailable', 'the memoised row follows presence')

    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: mkTmpDir(t), flags: aFlags })
    const burst = Array.from({ length: 20 }, (_, i) => `late-${String(i).padStart(2, '0')}.txt`)
    for (const name of burst) await add(name)

    const expected = ['/first.txt', ...burst.map((n) => '/' + n)].sort()
    const listed = await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && expected.every((p) => f.some((e) => e.path === p && e.status === 'remote')), { ms: 90000 })
    t.alike(listed.map((e) => e.path).sort(), expected, 'every file, and nothing else')
    A.kill()
  })
