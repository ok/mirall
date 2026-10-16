import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A download that names a folder lands there: a folder's file keeps its place under the folder's
// name, a loose file lands flat. The named folder becomes the space's, the rows read downloaded, and
// Reveal opens the landed copy.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex() })

test('a folder file and a loose file asked into a folder land there and make it the space\'s',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).personKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    fs.mkdirSync(path.join(folder, 'sub'), { recursive: true })
    const docBytes = patternedBytes(96 * 1024, 11)
    fs.writeFileSync(path.join(folder, 'sub', 'doc.bin'), docBytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    const src = mkTmpDir(t)
    const looseBytes = patternedBytes(64 * 1024, 13)
    fs.writeFileSync(path.join(src, 'loose.bin'), looseBytes)
    await A.request('files:add', { spaceId, filePath: path.join(src, 'loose.bin'), fileName: 'loose.bin', fileSize: looseBytes.length })

    const listing = { spaceId, ownerKey: aKey, shareId: share.id }
    const docIs = (status) => (list) => Array.isArray(list?.entries) && list.entries.some((e) => e.relPath === 'sub/doc.bin' && e.status === status)
    await B.until('share:list-files', listing, docIs('remote'), { ms: 60000 })
    await B.untilFiles(spaceId, (f) => f.some((e) => e.path === '/loose.bin' && e.status === 'remote'), { ms: 60000 })

    const chosen = mkTmpDir(t)
    const docDone = B.waitFor('event:transfer-complete', (m) => m.path === '/Vault/sub/doc.bin', 120000)
    await B.request('share:read-file', { ...listing, relPath: 'sub/doc.bin', destDir: chosen })
    const doc = await docDone
    const looseDone = B.waitFor('event:transfer-complete', (m) => m.path === '/loose.bin', 120000)
    await B.request('files:download', { spaceId, ownerKey: aKey, path: '/loose.bin', destDir: chosen })
    const loose = await looseDone

    const docAt = path.join(chosen, 'Vault', 'sub', 'doc.bin')
    const looseAt = path.join(chosen, 'loose.bin')
    t.is(doc.localPath, docAt, 'the folder file keeps its place under the folder\'s name')
    t.is(loose.localPath, looseAt, 'the loose file lands flat')
    t.ok(fs.readFileSync(docAt).equals(docBytes) && fs.readFileSync(looseAt).equals(looseBytes), 'both byte-exact')
    t.absent(fs.readdirSync(B.downloads, { recursive: true }).some((f) => String(f).includes('.bin')), 'nothing landed in the folder the space had before')

    const spaces = await B.request('spaces:list', {})
    t.is(spaces.find((s) => s.spaceId === spaceId)?.downloadFolder, chosen, 'the named folder is now the space\'s')
    t.ok((await B.request('settings:get', {})).downloads.recent[0] === chosen, 'and the newest recent folder')

    await B.until('share:list-files', listing, docIs('downloaded'), { ms: 60000 })
    await B.untilFiles(spaceId, (f) => f.some((e) => e.path === '/loose.bin' && e.status === 'downloaded'), { ms: 60000 })
    t.pass('both rows read downloaded')

    t.is((await B.request('share:reveal-file', { ...listing, relPath: 'sub/doc.bin' })).path, docAt, 'Reveal opens the folder file where it landed')
    t.is((await B.request('files:reveal', { spaceId, path: '/loose.bin' })).path, looseAt, 'and the loose file')

    A.kill()
  })
