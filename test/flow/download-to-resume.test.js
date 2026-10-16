import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A file under way keeps its folder: a batch interrupted in one folder resumes there after the space
// moved to another, and only files that start afterwards land in the new one.

test('an interrupted download resumes in its own folder after the space switched; a new one lands in the new folder',
  { timeout: scaled(300000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = mkStoreDir(t)
    const folder = mkTmpDir(t)
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t) })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).personKey
    await B.request('settings:set-bandwidth', { downloadKBps: 512 })

    const share = await A.request('share:create', { spaceId, name: 'Docs', contentMode: 'overlay' })
    const bigBytes = patternedBytes(6 * 1024 * 1024, 29)
    const laterBytes = patternedBytes(48 * 1024, 31)
    fs.writeFileSync(path.join(folder, 'big.bin'), bigBytes)
    fs.writeFileSync(path.join(folder, 'later.bin'), laterBytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    const listing = { spaceId, ownerKey: aKey, shareId: share.id }
    const rowIs = (rel, status) => (list) => Array.isArray(list?.entries) && list.entries.some((e) => e.relPath === rel && e.status === status)
    await B.until('share:list-files', listing, rowIs('big.bin', 'remote'), { ms: 60000 })

    const first = mkTmpDir(t)
    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => {
        if (m.channel !== 'transfer' || m.key !== share.id + ':big.bin' || m.done) return
        if (m.bytes > 0) resolve()
      })
    })
    t.is((await B.request('share:read-files', { ...listing, relPaths: ['big.bin'], destDir: first })).started, 1)
    await flowing

    A.kill()
    await B.until('share:list-files', listing, rowIs('big.bin', 'paused-offline'), { ms: 120000 })
    const bigAt = path.join(first, 'Docs', 'big.bin')
    t.ok(fs.existsSync(bigAt + '.mirall.part'), 'precondition: the partial sits in the first folder')

    const second = mkTmpDir(t)
    await B.request('space:update', { spaceId, downloadFolder: second })
    const spaces = await B.request('spaces:list', {})
    t.is(spaces.find((s) => s.spaceId === spaceId)?.downloadFolder, second, 'the space now downloads into the second folder')

    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Docs/big.bin', 180000)
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    await B.request('settings:set-bandwidth', { downloadKBps: 0 })
    const completed = await done
    t.is(completed.localPath, bigAt, 'the interrupted file resumed in its own folder')
    t.ok(fs.readFileSync(bigAt).equals(bigBytes), 'byte-exact')
    t.absent(fs.existsSync(path.join(second, 'Docs', 'big.bin')), 'nothing of it landed in the second folder')

    await B.until('share:list-files', listing, rowIs('later.bin', 'remote'), { ms: 60000 })
    const laterDone = B.waitFor('event:transfer-complete', (m) => m.path === '/Docs/later.bin', 120000)
    await B.request('share:read-file', { ...listing, relPath: 'later.bin' })
    t.is((await laterDone).localPath, path.join(second, 'Docs', 'later.bin'), 'a file started afterwards lands in the second folder')

    A.kill()
  })
