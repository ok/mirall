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
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })
const scopeIs = (kind, spaceId) => (m) => !!m.scope && m.scope.kind === kind && m.scope.spaceId === spaceId

// A loose file shared AFTER connect must fan a files-scoped reconcile hint to the peer so a
// level-triggered files view re-derives and surfaces it — the worker-side fan-out the s4/s10/s71
// "stuck on Nothing shared yet" visibility rides on. reconcile-hints covers members/shares
// transitions but not a peer's loose share.
test('a peer\'s loose share fans a files-scoped reconcile hint to the other peer',
  { timeout: scaled(120000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)

    // List once so B binds A's catalog (registers the peer-catalog append watch).
    await B.request('files:list', { spaceId })

    const src = path.join(mkTmpDir(t), 'report.txt')
    fs.writeFileSync(src, Buffer.alloc(4096, 7))

    const sawFilesHint = B.waitFor('event:reconcile', scopeIs('files', spaceId), 60000)
    await A.request('files:add', { spaceId, filePath: src, fileName: 'report.txt', fileSize: 4096 })
    await sawFilesHint
    t.pass('B received a files-scoped reconcile hint for A\'s loose share')

    const entry = await waitForCatalogEntry(B, spaceId, '/report.txt')
    t.ok(entry, 'B lists the loose file A shared after connect')

    A.kill()
  })
