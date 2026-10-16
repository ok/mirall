import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A batch behind a one-slot gate: the listing reads one row downloading and the rest waiting, a
// waiting row can be cancelled before a byte lands, and the rest still complete. The cap comes from
// the worker's own settings file, written before it boots; the download cap keeps each fetch open
// long enough for a poll to see the queue.
const NAMES = ['one.bin', 'two.bin', 'three.bin']

test('a batch on a one-slot gate reads downloading and waiting, and a waiting row cancels clean',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t) })
    const bStore = mkStoreDir(t)
    fs.writeFileSync(path.join(path.dirname(bStore), 'settings.json'), JSON.stringify({ network: { downloadConcurrency: 1 } }))
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStore, downloads: mkTmpDir(t) })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).personKey
    await B.request('settings:set-bandwidth', { downloadKBps: 1024 })

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    for (const [i, name] of NAMES.entries()) fs.writeFileSync(path.join(folder, name), patternedBytes(4 * 1024 * 1024, 11 + i))
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    const listing = { spaceId, ownerKey: aKey, shareId: share.id }
    const rows = (list) => (Array.isArray(list?.entries) ? list.entries.filter((e) => NAMES.includes(e.relPath)) : [])
    await B.until('share:list-files', listing, (list) => rows(list).length === 3 && rows(list).every((e) => e.status === 'remote'), { ms: 60000 })

    const res = await B.request('share:read-files', { ...listing, relPaths: NAMES })
    t.alike(res, { started: 3, alreadyHere: 0, waitingOnOwner: 0, removed: 0, failed: 0 })

    const queued = await B.until('share:list-files', listing, (list) => {
      const r = rows(list)
      return r.filter((e) => e.status === 'downloading').length === 1 && r.filter((e) => e.status === 'waiting').length === 2
    }, { ms: 60000 })
    const waiting = rows(queued).filter((e) => e.status === 'waiting')
    t.ok(waiting.every((e) => e.transferId), 'a waiting row carries its transfer id, so it can be cancelled')

    const victim = waiting[0]
    await B.request('files:cancel-download', { transferId: victim.transferId })
    await B.until('share:list-files', listing, (list) => rows(list).some((e) => e.relPath === victim.relPath && e.status === 'remote'), { ms: 30000 })
    const onDisk = () => fs.readdirSync(B.downloads, { recursive: true }).map(String).filter((f) => f.includes(victim.relPath))
    t.alike(onDisk(), [], 'a cancelled waiting row left nothing on disk')

    await B.request('settings:set-bandwidth', { downloadKBps: 0 })
    const rest = NAMES.filter((n) => n !== victim.relPath)
    await B.until('share:list-files', listing, (list) => rest.every((n) => rows(list).some((e) => e.relPath === n && e.status === 'downloaded')), { ms: 120000 })
    for (const n of rest) t.ok(fs.existsSync(path.join(B.downloads, 'Vault', n)), n + ' completed under the folder')

    A.kill()
  })
