import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, waitForCatalogEntry } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex() })
// The loose list is the '__loose__' share-files listing; a wildcard would also reach it, but this pins
// that the peer's loose catalog watch names it.
const looseListing = (spaceId) => (m) => m.scope?.kind === 'share-files' && m.scope.spaceId === spaceId && m.scope.shareId === '__loose__'

// A loose file shared AFTER connect must fan a loose-listing reconcile hint to the peer so a
// level-triggered loose list re-derives and surfaces it — the worker-side fan-out the s4/s10/s71
// "stuck on Nothing shared yet" visibility rides on. reconcile-hints covers members/shares
// transitions but not a peer's loose share.
test('a peer\'s loose share fans a loose-listing reconcile hint to the other peer',
  { timeout: scaled(120000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)

    // List once so B binds A's catalog (registers the peer-catalog append watch).
    await B.request('files:list', { spaceId })

    const src = path.join(mkTmpDir(t), 'report.txt')
    fs.writeFileSync(src, Buffer.alloc(4096, 7))

    const sawFilesHint = B.waitFor('event:reconcile', looseListing(spaceId), 60000)
    await A.request('files:add', { spaceId, filePath: src, fileName: 'report.txt', fileSize: 4096 })
    await sawFilesHint
    t.pass('B received a loose-listing reconcile hint for A\'s loose share')

    const entry = await waitForCatalogEntry(B, spaceId, '/report.txt')
    t.ok(entry, 'B lists the loose file A shared after connect')

    A.kill()
  })
