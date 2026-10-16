import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { resolveDest, reuseDest } from '../../src/shared/transfer/download-dest.js'

// A destination is resolved from a path relative to the download root: a bare name lands in the
// root exactly as it always has, a path with folders lands below it, and only the leaf ever takes
// a collision-avoiding name.

test('a base name resolves exactly as before', async (t) => {
  const { downloads } = await freshPeer(t)
  t.is(resolveDest(downloads, 'a.txt'), path.join(downloads, 'a.txt'))
  fs.writeFileSync(path.join(downloads, 'a.txt'), 'x')
  t.is(resolveDest(downloads, 'a.txt'), path.join(downloads, 'a (1).txt'), 'a taken name still steps to a sibling')
})

test('a relative path lands below the root, keeping its folders', async (t) => {
  const { downloads } = await freshPeer(t)
  t.is(resolveDest(downloads, 'Folder/sub/a.txt'), path.join(downloads, 'Folder', 'sub', 'a.txt'))
})

test('a file already in the subfolder gives a free sibling in that subfolder', async (t) => {
  const { downloads } = await freshPeer(t)
  fs.mkdirSync(path.join(downloads, 'Folder', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(downloads, 'Folder', 'sub', 'a.txt'), 'x')
  t.is(resolveDest(downloads, 'Folder/sub/a.txt'), path.join(downloads, 'Folder', 'sub', 'a (1).txt'))
})

test('a reserved destination is treated as taken, so two batches never share a name', async (t) => {
  const { downloads } = await freshPeer(t)
  const first = resolveDest(downloads, 'Folder/a.txt')
  const reserved = new Set([first])
  t.is(resolveDest(downloads, 'Folder/a.txt', reserved), path.join(downloads, 'Folder', 'a (1).txt'))
  t.is(resolveDest(downloads, 'Folder/b.txt', reserved), path.join(downloads, 'Folder', 'b.txt'), 'other names are untouched')
})

test('a path that escapes the root is refused', async (t) => {
  const { downloads } = await freshPeer(t)
  for (const rel of ['../x/a.txt', '/abs/a.txt', 'Folder/../../a.txt']) {
    let code = null
    try { resolveDest(downloads, rel) } catch (err) { code = err.code }
    t.is(code, 'EPATH', rel + ' is refused')
  }
})

test('reuseDest keeps a nested pin inside the root and re-resolves one outside it under the same relative path', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  const nested = path.join(downloads, 'Folder', 'sub', 'a.txt')
  t.is(reuseDest(nested, downloads, 'Folder/sub/a.txt'), nested, 'a pin inside the root is kept')

  const moved = tmpDir('dl-moved')
  t.is(reuseDest(nested, moved, 'Folder/sub/a.txt'), path.join(moved, 'Folder', 'sub', 'a.txt'), 'a pin outside the new root lands under the same folders, not flat')
})
