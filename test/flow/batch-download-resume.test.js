import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A tree download interrupted by its owner going away resumes into the SAME nested destination:
// the pending row carries the layout, so the reconcile that re-drives it lands the file under the
// folder, not flat in the root.

test('a tree download interrupted mid-batch resumes into its nested destination',
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
    const rel = 'deep/nested/big.bin'
    const abs = path.join(folder, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const bytes = patternedBytes(6 * 1024 * 1024, 23)
    fs.writeFileSync(abs, bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    const listing = { spaceId, ownerKey: aKey, shareId: share.id }
    const rowIs = (status) => (list) => Array.isArray(list?.entries) && list.entries.some((e) => e.relPath === rel && e.status === status)
    await B.until('share:list-files', listing, rowIs('remote'), { ms: 60000 })

    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => {
        if (m.channel !== 'transfer' || m.key !== share.id + ':' + rel || m.done) return
        if (m.bytes > 0) resolve()
      })
    })
    const res = await B.request('share:read-files', { ...listing, relPaths: [rel] })
    t.is(res.started, 1)
    await flowing

    A.kill()
    await B.until('share:list-files', listing, rowIs('paused-offline'), { ms: 120000 })
    const expected = path.join(B.downloads, 'Docs', 'deep', 'nested', 'big.bin')
    t.ok(fs.existsSync(expected + '.mirall.part'), 'the partial sits at the nested destination')

    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Docs/' + rel, 180000)
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    await B.request('settings:set-bandwidth', { downloadKBps: 0 })
    const completed = await done
    t.is(completed.localPath, expected, 'resumed into the same nested path')
    t.ok(fs.readFileSync(expected).equals(bytes), 'byte-exact after the resume')
    t.absent(fs.existsSync(path.join(B.downloads, 'big.bin')), 'nothing landed flat in the root')

    A.kill()
  })

// An offline owner's files have no enabled Download on their rows, but a batch still asks for
// them: every file is kept as a pending row that reads paused-offline, and the whole batch lands in
// its folder once the owner is back.
test('a folder batch asked for while the owner is offline is kept and lands when they return',
  { timeout: scaled(300000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = mkStoreDir(t)
    const folder = mkTmpDir(t)
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t) })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).personKey

    const share = await A.request('share:create', { spaceId, name: 'Archive', contentMode: 'overlay' })
    const files = { 'one.bin': patternedBytes(96 * 1024, 31), 'sub/two.bin': patternedBytes(64 * 1024, 37) }
    for (const [rel, bytes] of Object.entries(files)) {
      const abs = path.join(folder, ...rel.split('/'))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, bytes)
    }
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    const listing = { spaceId, ownerKey: aKey, shareId: share.id }
    const relPaths = Object.keys(files)
    const allAre = (status) => (list) => Array.isArray(list?.entries) && relPaths.every((rel) => list.entries.some((e) => e.relPath === rel && e.status === status))
    await B.until('share:list-files', listing, allAre('remote'), { ms: 60000 })

    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })
    await B.until('share:list-files', listing, allAre('unavailable'), { ms: 60000 })

    const res = await B.request('share:read-files', { ...listing, relPaths })
    t.alike(res, { started: 0, alreadyHere: 0, waitingOnOwner: 2, removed: 0, failed: 0 }, 'every file is kept for the owner\'s return')
    await B.until('share:list-files', listing, allAre('paused-offline'), { ms: 30000 })

    const completions = relPaths.map((rel) => B.waitFor('event:transfer-complete', (m) => m.path === '/Archive/' + rel, 180000))
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    await Promise.all(completions)
    for (const [rel, bytes] of Object.entries(files)) {
      const landed = path.join(B.downloads, 'Archive', ...rel.split('/'))
      t.ok(fs.readFileSync(landed).equals(bytes), rel + ' landed byte-exact in its folder')
    }

    A.kill()
  })
