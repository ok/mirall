import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { getStore, getStoragePath } from '../../src/shared/core/store.js'
import { createSpace, getDrive, purgeSpaceDrive } from '../../src/shared/spaces/space.js'

function dirSize (dir) {
  let n = 0
  for (const e of fs.readdirSync(dir)) {
    const full = path.join(dir, e)
    const st = fs.statSync(full)
    n += st.isDirectory() ? dirSize(full) : st.size
  }
  return n
}

// REGRESSION (FIX-145: leave-space deleted the drive header via range-delete but never
// cleared its blocks, so RocksDB kept the blob-separated content — the store never shrank).
test('leaving a space with drive content physically frees disk', async (t) => {
  await freshPeer(t)
  const FILE = 8 * 1024 * 1024
  const s = await createSpace('S')
  const drive = getDrive(s.spaceId)
  await drive.ready()
  await drive.put('/big.bin', Buffer.alloc(FILE, 7))
  await getStore().storage.db.flush()

  const before = dirSize(getStoragePath())
  t.ok(before >= FILE * 0.8, `store holds the blob (${before})`)

  await purgeSpaceDrive(s.spaceId)

  const after = dirSize(getStoragePath())
  t.ok(before - after >= FILE * 0.5, `leave reclaimed the blob (freed ${before - after}, before=${before} after=${after})`)
})
