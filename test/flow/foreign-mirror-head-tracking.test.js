import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// The safety premise of the mirror-walk skip, and the ONE property no single-peer test can reach.
//
// A converged mirror stops listing the owner's catalog and instead compares a locally-read
// `bee.version` against the version its last converged pass walked. That is only sound if a REMOTE
// owner's append advances that number on OUR reader with no core.update({ wait: true }) — i.e. if
// hypercore's eagerUpgrade really does keep a connected reader's core.length current. Every
// integration test stubs the probe with a hand-driven counter, so none of them can see this: if the
// premise were false, they would all still pass while every real mirror silently froze.
//
// The backstop is disabled here (foreignFullWalkEvery far beyond any tick this test will run) so it
// cannot mask a failure. With a working probe the new file lands in seconds; with a broken one it
// would wait for tick 5000 and this test would time out — which is exactly the signal wanted.
test('a remote owner append advances the mirror\'s local catalog version', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, {
    bootstrap,
    displayName: 'Bob',
    flags: { foreignFullWalkEvery: 5000, foreignPollIntervalMs: 1000 },
  })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Photos' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'first.txt'), 'one')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (list) => list.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active')
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  t.ok(fs.existsSync(path.join(mirrorDir, 'first.txt')), 'the mirror converged on the initial file')

  // Let several poll ticks run against an unchanged catalog. By the end of this the mirror is in the
  // skipping state the rest of the test depends on — with the backstop 5000 ticks away, nothing but
  // a version change can bring it back.
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (res) => res.entries.length === 1)
  await new Promise((r) => setTimeout(r, 4000))

  // A publishes a second file. This is the only thing that moves A's catalog head.
  const late = path.join(folder, 'second.txt')
  fs.writeFileSync(late, 'two')
  await A.request('event:owned-folder-fs-event', { shareId: share.id, action: 'add', relPath: 'second.txt', absPath: late })
  await A.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (res) => res.entries.length === 2)

  // B's LISTING seeing the row proves only that the catalog replicated — share:list-files reads the
  // catalog directly and does not go through the mirror tick at all. Verified against a deliberately
  // frozen probe: this wait still passed while the file was never mirrored.
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (res) => res.entries.length === 2)

  // THIS is the discriminating assertion. Materializing requires a tick that chose to walk, which
  // requires B's locally-read version to have moved. With the probe frozen the same listing reports
  // second.txt as status 'remote' with localPath null — visible, and never mirrored — and this wait
  // is what goes red.
  const landed = path.join(mirrorDir, 'second.txt')
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    () => fs.existsSync(landed))
  t.ok(fs.existsSync(landed), 'the appended file materialized on the mirror without a backstop walk')
  t.is(fs.readFileSync(landed, 'utf8'), 'two', 'and its bytes are the owner\'s')
})
