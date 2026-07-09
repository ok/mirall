import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace, getDrive } from '../../src/shared/spaces/space.js'
import { initDownloads, addFile } from '../../src/shared/transfer/files.js'
import { getStorageInfo, getSpaceCacheBytes } from '../../src/shared/storage/storage.js'

// Overlay copies no bytes into the per-space drive (it serves straight from the
// source file), so a space's only retained bytes are its metadata core.
test('per-space byte breakdown is internally consistent (no drive content)', async (t) => {
  const { tmpDir } = await freshPeer(t)
  await initDownloads()
  const space = await createSpace('Aurora')

  const before = (await getStorageInfo()).spaces.find((s) => s.spaceId === space.spaceId)
  t.ok(before, 'the space appears in the breakdown')
  t.is(before.contentBytes, 0, 'no drive content before any file is added')

  // A loose file is served in place — its bytes never enter the drive.
  const src = path.join(tmpDir('src'), 'big.bin')
  fs.writeFileSync(src, Buffer.alloc(64 * 1024, 7))
  await addFile(space.spaceId, src, 'big.bin')

  const info = await getStorageInfo()
  const s = info.spaces.find((x) => x.spaceId === space.spaceId)
  t.is(s.contentBytes, 0, 'still no drive content (overlay/loose serve in place)')
  t.is(s.totalBytes, s.metadataBytes + s.contentBytes, 'totalBytes = metadata + content')
  t.ok(info.totalDiskUsage >= s.totalBytes, 'on-disk usage covers the space total')
})

// getSpaceCacheBytes is the "X will be freed" figure shown before an irreversible
// leave. It measures the local per-space drive's metadata core (overlay leaves no
// blob cache to reclaim).
test('getSpaceCacheBytes reports the local drive footprint', async (t) => {
  await freshPeer(t)
  await initDownloads()
  const space = await createSpace('Aurora')

  const drive = getDrive(space.spaceId)
  await drive.ready()
  const bytes = await getSpaceCacheBytes(space.spaceId)
  // Not just `>= 0` (any byte count satisfies that) — assert it IS the local per-space
  // drive's metadata core size, the figure the pre-leave "X will be freed" number relies on.
  t.is(bytes, drive.core.byteLength, 'reports exactly the local per-space drive metadata core size')
})
