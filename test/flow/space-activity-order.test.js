import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A change inside a member's shared folder writes no audit row, so the folder's catalog itself has
// to mark the space active on the other device, and spaces:list carries it first.
test('a member editing their shared folder moves the space to the top of the list',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const bKey = (await B.request('profile:get')).personKey
    const shared = await connectInSpace(t, A, B, 'Shared')

    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'plan.txt'), 'v1')
    const share = await B.request('share:create', { spaceId: shared, name: 'Plans' })
    const scanned = B.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await B.request('owned-folder:mount', { spaceId: shared, shareId: share.id, mountPath: folder })
    await scanned
    // Alice opens the folder, as browsing it does; the history that arrives is adoption, not news.
    await A.until('share:list-files', { spaceId: shared, ownerKey: bKey, shareId: share.id },
      (r) => Array.isArray(r?.entries) && r.entries.some((e) => e.relPath === 'plan.txt'), { ms: 90000 })

    const quiet = await A.request('space:create', { name: 'Quiet' })
    const first = async () => (await A.request('spaces:list'))[0].spaceId
    t.is(await first(), quiet.spaceId, 'precondition: the space just created is the most recent')

    fs.writeFileSync(path.join(folder, 'plan.txt'), 'v2-edited')
    await B.request('event:owned-folder-fs-event',
      { shareId: share.id, action: 'change', relPath: 'plan.txt', absPath: path.join(folder, 'plan.txt') })

    await A.until('spaces:list', {}, (list) => list[0]?.spaceId === shared, { ms: 90000 })
    const [top] = await A.request('spaces:list')
    t.ok(top.lastActivity > Date.parse(quiet.created), 'stamped when Alice saw the edit')

    A.kill()
    B.kill()
  })
