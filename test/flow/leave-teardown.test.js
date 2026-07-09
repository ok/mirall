import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { MODES } from '../helpers/modes.js'

for (const mode of MODES) {
// FIX-1 — leaving a space must tear down its folder machinery (watcher, loops,
// periodic reconcile, cached views, mounts) BEFORE purging the drive. Without
// it, the next fs event / timer tick writes to a closed-and-purged drive. We
// assert the observable effect: the space's owned mount is gone after leave and
// the worker stays healthy. RED before FIX-1 (the leave handler left mounts).
test(`REGRESSION (FIX-1): leaving a space tears down its folder mounts [${mode.name}]`, { timeout: 60000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', flags: mode.flags() })

  const space = await A.request('space:create', { name: 'Aurora' })
  const share = await A.request('share:create', { spaceId: space.spaceId, name: 'Notes' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'a.txt'), 'hi')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId: space.spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  const before = await A.request('owned-folder:list-all')
  t.ok(before.some((m) => m.shareId === share.id), 'owned mount present before leave')

  await A.request('space:leave', { spaceId: space.spaceId })

  const after = await A.request('owned-folder:list-all')
  t.absent(after.some((m) => m.shareId === share.id), 'owned mount torn down by leave')

  // No write-after-purge crash — the worker still answers.
  t.ok((await A.request('ping')).pong, 'worker still responsive after leave')
})

// (FIX-2 removed: it guarded the eager drive-listing race during leave —
// SESSION_CLOSED / "error listing local drive" / "cannot measure peer drive" — which
// is structurally impossible now that the per-space-drive flat-list collectors are gone.
// The seed-mode loose peer-catalog gap its setup surfaced is tracked in #327.)
}
