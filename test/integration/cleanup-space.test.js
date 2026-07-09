import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import Hyperdrive from 'hyperdrive'
import { freshPeer } from '../helpers/store.js'
import { getStore, getStoragePath } from '../../src/shared/core/store.js'
import { compactStore } from '../../src/shared/transfer/swarm.js'

function dirSize(dir) {
  let n = 0
  for (const e of fs.readdirSync(dir)) {
    const full = path.join(dir, e)
    const st = fs.statSync(full)
    n += st.isDirectory() ? dirSize(full) : st.size
  }
  return n
}

// "Clear peer cache" calls drive.clearAll() then compactStore(). clearAll() only
// tombstones the replicated blocks in the shared RocksDB store — the bytes are
// not returned to the OS until a compaction runs. This pins down both halves:
// clear-without-compact leaves the bytes on disk (the reported bug), and the
// compaction is what actually reclaims them.
test('clearing a peer drive reclaims disk only after a store compaction', async (t) => {
  await freshPeer(t)
  const db = getStore().storage.db
  const FILE = 8 * 1024 * 1024

  // A replicated peer drive that has pulled ~8 MB of content onto disk.
  const peer = new Hyperdrive(getStore().namespace('peer-sim'))
  await peer.ready()
  await peer.put('/big.bin', Buffer.alloc(FILE, 7))
  await db.flush()

  const baseline = dirSize(getStoragePath())
  t.ok(baseline >= FILE * 0.8, `store holds the blob on disk (${baseline} bytes)`)

  await peer.clearAll()
  await db.flush()
  const afterClear = dirSize(getStoragePath())
  t.comment(`after clearAll (no compaction): ${afterClear} bytes`)
  t.ok(baseline - afterClear < FILE * 0.5, 'clearAll alone leaves the bytes on disk (the reported bug)')

  await compactStore()
  const afterCompact = dirSize(getStoragePath())
  t.ok(baseline - afterCompact >= FILE * 0.5,
    `compaction reclaims the tombstoned bytes (freed ${baseline - afterCompact})`)
})
