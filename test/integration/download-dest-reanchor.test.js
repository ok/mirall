import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { resolveDest, reuseDest } from '../../src/shared/transfer/download-dest.js'

// A pending transfer records its destination at start and keeps it across a pause. Per-space
// download folders made that pin outlive the folder it was resolved against.

test('reuseDest keeps a pin that still sits inside the folder', async (t) => {
  const { downloads } = await freshPeer(t)
  const pinned = path.join(downloads, 'big.iso')
  t.is(reuseDest(pinned, downloads, 'big.iso'), pinned, 'resuming into the same folder reuses the path')
  const nested = path.join(downloads, 'sub', 'big.iso')
  t.is(reuseDest(nested, downloads, 'big.iso'), nested, 'including a nested one')
})

// REGRESSION (DL-6): the pin won unconditionally (`prev?.finalPath || resolveDest(...)`), so a
// transfer paused before the user re-pointed the space completed into the OLD folder — landing
// outside the space's scope and reporting as never downloaded, which invited a full re-download
// alongside it.
test('REGRESSION: reuseDest re-anchors a pin left behind by a folder change', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  const moved = tmpDir('dl-moved')
  const stale = path.join(downloads, 'big.iso')

  const dest = reuseDest(stale, moved, 'big.iso')
  t.is(path.dirname(dest), moved, 're-resolved under the folder the space uses now')
  t.is(path.basename(dest), 'big.iso', 'and keeps the file name')
})

test('a re-anchored destination still avoids collisions in the new folder', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  const moved = tmpDir('dl-moved')
  fs.writeFileSync(path.join(moved, 'big.iso'), 'someone else')

  const dest = reuseDest(path.join(downloads, 'big.iso'), moved, 'big.iso')
  t.is(dest, path.join(moved, 'big (1).iso'), 'never overwrites a file already there')
  t.is(dest, resolveDest(moved, 'big.iso'), 'identical to a fresh resolve')
})

test('no pin at all resolves fresh', async (t) => {
  const { downloads } = await freshPeer(t)
  t.is(reuseDest(undefined, downloads, 'a.txt'), path.join(downloads, 'a.txt'))
  t.is(reuseDest(null, downloads, 'a.txt'), path.join(downloads, 'a.txt'))
})
