import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, addApprovedPeer } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A loose batch lands flat, one request per owner. Two owners' same-named files take free names
// rather than one landing over the other, and a batch for an owner who is away is kept as intent
// rows that read paused-offline until they return. The two owners' batches run one after the
// other: a loose transfer is named by its path alone, so two owners' same-named files share one
// transfer identity and the second request attaches to the first while it runs.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex() })

test('a loose batch per owner lands flat with free names, and an offline owner\'s batch is kept as intent',
  { timeout: scaled(300000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    await addApprovedPeer(A, C, spaceId)
    const aKey = (await A.request('profile:get')).personKey
    const cKey = (await C.request('profile:get')).personKey

    const share = async (P, name, seed) => {
      const dir = mkTmpDir(t)
      const bytes = patternedBytes(256 * 1024, seed)
      fs.writeFileSync(path.join(dir, name), bytes)
      await P.request('files:add', { spaceId, filePath: path.join(dir, name), fileName: name, fileSize: bytes.length })
      return bytes
    }
    const aBytes = await share(A, 'Brief.pdf', 3)
    const cBytes = await share(C, 'Brief.pdf', 5)
    const aNotes = await share(A, 'Notes.txt', 7)
    const owned = (list, key, name) => list.find((e) => e.path === '/' + name && e.owner?.publicKey === key)
    await B.untilFiles(spaceId, (f) => owned(f, aKey, 'Brief.pdf')?.status === 'remote' && owned(f, cKey, 'Brief.pdf')?.status === 'remote' && owned(f, aKey, 'Notes.txt')?.status === 'remote', { ms: 90000 })

    const doneA = Promise.all(['/Brief.pdf', '/Notes.txt'].map((p) => B.waitFor('event:transfer-complete', (m) => m.path === p, 120000)))
    const fromA = await B.request('files:download-many', { spaceId, ownerKey: aKey, paths: ['/Brief.pdf', '/Notes.txt'] })
    t.alike(fromA, { started: 2, alreadyHere: 0, waitingOnOwner: 0, removed: 0, failed: 0 })
    await doneA
    const doneC = B.waitFor('event:transfer-complete', (m) => m.path === '/Brief.pdf', 120000)
    const fromC = await B.request('files:download-many', { spaceId, ownerKey: cKey, paths: ['/Brief.pdf'] })
    t.alike(fromC, { started: 1, alreadyHere: 0, waitingOnOwner: 0, removed: 0, failed: 0 }, 'a copy of another owner\'s content under the same name is not "already here"')
    await doneC

    const names = fs.readdirSync(B.downloads).sort()
    t.alike(names, ['Brief (1).pdf', 'Brief.pdf', 'Notes.txt'], 'two owners\' same-named files took free names, flat in the root')
    const landed = [fs.readFileSync(path.join(B.downloads, 'Brief.pdf')), fs.readFileSync(path.join(B.downloads, 'Brief (1).pdf'))]
    t.ok(landed.some((b) => b.equals(aBytes)) && landed.some((b) => b.equals(cBytes)), 'both contents landed, neither over the other')
    t.ok(fs.readFileSync(path.join(B.downloads, 'Notes.txt')).equals(aNotes))

    await share(A, 'Later.txt', 9)
    await B.untilFiles(spaceId, (f) => owned(f, aKey, 'Later.txt')?.status === 'remote', { ms: 90000 })
    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })
    const away = await B.request('files:download-many', { spaceId, ownerKey: aKey, paths: ['/Later.txt'] })
    t.alike(away, { started: 0, alreadyHere: 0, waitingOnOwner: 1, removed: 0, failed: 0 })
    await B.untilFiles(spaceId, (f) => owned(f, aKey, 'Later.txt')?.status === 'paused-offline', { ms: 60000 })
    t.pass('the intent row is durable and reads paused-offline until the owner returns')

    C.kill()
  })
