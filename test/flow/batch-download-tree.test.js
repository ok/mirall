import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A folder batch keeps its folders: every file of share:read-files lands under
// <download folder>/<folder name>/<relPath>, so two files with one base name in different folders
// never collide into "a (1).txt". A second batch for the same files starts nothing.
const FILES = { 'a.txt': 1, 'Contracts/a.txt': 2, 'Photos/raw/x.bin': 3 }

test('a folder batch lands under the folder name with its relative paths kept',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t) })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t) })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).personKey

    const share = await A.request('share:create', { spaceId, name: 'Handover', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const bytes = {}
    for (const [rel, seed] of Object.entries(FILES)) {
      const abs = path.join(folder, ...rel.split('/'))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      bytes[rel] = patternedBytes(64 * 1024 + seed, seed)
      fs.writeFileSync(abs, bytes[rel])
    }
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    const listing = { spaceId, ownerKey: aKey, shareId: share.id }
    const relPaths = Object.keys(FILES)
    const allAre = (status) => (list) => Array.isArray(list?.entries) && relPaths.every((rel) => list.entries.some((e) => e.relPath === rel && e.status === status))
    await B.until('share:list-files', listing, allAre('remote'), { ms: 60000 })

    const completions = relPaths.map((rel) => B.waitFor('event:transfer-complete', (m) => m.path === '/Handover/' + rel, 120000))
    const res = await B.request('share:read-files', { ...listing, relPaths })
    t.alike(res, { started: 3, alreadyHere: 0, waitingOnOwner: 0, removed: 0, failed: 0 })
    const landed = await Promise.all(completions)

    for (const rel of relPaths) {
      const expected = path.join(B.downloads, 'Handover', ...rel.split('/'))
      t.ok(fs.existsSync(expected), rel + ' landed at ' + expected)
      t.ok(fs.readFileSync(expected).equals(bytes[rel]), rel + ' is byte-exact')
      t.ok(landed.some((m) => m.localPath === expected), rel + ' completed at its nested path')
    }
    const everything = fs.readdirSync(B.downloads, { recursive: true }).map(String)
    t.absent(everything.some((f) => f.includes('(1)')), 'no collision sibling anywhere')

    await B.until('share:list-files', listing, allAre('downloaded'), { ms: 60000 })
    t.alike(await B.request('share:read-files', { ...listing, relPaths }), { started: 0, alreadyHere: 3, waitingOnOwner: 0, removed: 0, failed: 0 })
    t.is(fs.readdirSync(B.downloads, { recursive: true }).length, everything.length, 'a second batch wrote nothing')

    A.kill()
  })
