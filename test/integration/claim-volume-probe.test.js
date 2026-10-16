import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { verdictForClaim } from '../../src/shared/transfer/files.js'

// The claim rule asks whether the VOLUME is there when a copy is missing. For a copy below the
// download root that question is about the root: a user who deleted a whole batch folder deleted
// copies, and the claim must be pruned rather than kept forever as "volume detached".

const rec = (localPath) => ({ downloadedAt: 1, localPath, hash: 'h' })

test('a copy deleted with its whole batch folder is pruned, not kept as a detached volume', async (t) => {
  const { downloads } = await freshPeer(t)
  const batch = path.join(downloads, 'Batch')
  const copy = path.join(batch, 'a.txt')
  fs.mkdirSync(batch, { recursive: true })
  fs.writeFileSync(copy, 'x')
  t.ok(verdictForClaim('s', '/Batch/a.txt', rec(copy), 'h').downloaded, 'present while the copy is there')

  fs.rmSync(batch, { recursive: true, force: true })
  const verdict = verdictForClaim('s', '/Batch/a.txt', rec(copy), 'h')
  t.absent(verdict.downloaded)
  t.ok(verdict.prune, 'the root is there, so the copy was deleted')
  t.is(verdict.reason, 'local-file-gone')
})

test('a copy whose download root is gone is kept, as a detached volume', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  const detached = tmpDir('volume')
  const copy = path.join(detached, 'Batch', 'a.txt')
  fs.rmSync(detached, { recursive: true, force: true })
  // A copy outside every download root answers for its own folder.
  const outside = verdictForClaim('s', '/Batch/a.txt', rec(copy), 'h')
  t.absent(outside.prune)
  t.is(outside.reason, 'volume-unavailable')

  fs.rmSync(downloads, { recursive: true, force: true })
  const inRoot = verdictForClaim('s', '/Batch/b.txt', rec(path.join(downloads, 'Batch', 'b.txt')), 'h')
  t.absent(inRoot.prune, 'the root itself is gone: the volume, not the copy')
  t.is(inRoot.reason, 'volume-unavailable')
})

test('a flat claim behaves as before', async (t) => {
  const { downloads } = await freshPeer(t)
  const copy = path.join(downloads, 'a.txt')
  const gone = verdictForClaim('s', '/a.txt', rec(copy), 'h')
  t.ok(gone.prune, 'a missing flat copy in a present root is pruned')
  fs.writeFileSync(copy, 'x')
  t.ok(verdictForClaim('s', '/a.txt', rec(copy), 'h').downloaded)
})
