// Benchmark the producer prepare pass (Phase 1/2 validation, plan-publish-cpu-optimization.md).
// Run under bare:  bare scripts/bench-prepare.js [sizeMB=512]
// Compares the OLD 64 KiB createReadStream chunking against the NEW block-read
// prepareFile on the same file/host, reporting wall-clock, MB/s, and chunkStats
// ratios per file byte (concat ~tens× → ~1×; copy → 0). Observe peak RSS
// externally (Activity Monitor / `top`) — bare lacks process.memoryUsage.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Corestore from 'corestore'
import { FileIndex } from '../src/shared/transfer/backends/overlay/vendor/file-index.js'
import { TransferManager } from '../src/shared/transfer/backends/overlay/vendor/transfer.js'
import { chunkStream, selectTier, setChunkStats, chunkStats } from '../src/shared/transfer/backends/overlay/vendor/chunker.js'

const sizeMB = Number(Bare.argv[2] || 512)
const sizeBytes = sizeMB * 1024 * 1024
const dir = path.join(os.tmpdir(), 'mirall-bench-' + Date.now())
fs.mkdirSync(dir, { recursive: true })
const filePath = path.join(dir, 'fixture.bin')

const fill = Buffer.allocUnsafe(1024 * 1024)
let x = 0x9e3779b9
const wfd = fs.openSync(filePath, 'w')
let written = 0
while (written < sizeBytes) {
  for (let i = 0; i < fill.length; i += 4) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0
    fill.writeUInt32LE(x, i)
  }
  const n = Math.min(fill.length, sizeBytes - written)
  fs.writeSync(wfd, fill, 0, n, written)
  written += n
}
fs.closeSync(wfd)

const tier = selectTier(sizeBytes)
const round = (n) => Math.round(n * 1000) / 1000

setChunkStats(true)
let t0 = Date.now()
for await (const c of chunkStream(fs.createReadStream(filePath), { tier })) void c
const oldMs = Date.now() - t0
const oldStats = { ...chunkStats }

const store = new Corestore(path.join(dir, 'store'))
const index = new FileIndex(store)
await index.ready()
const transfer = new TransferManager(index)

setChunkStats(true)
t0 = Date.now()
const result = await transfer.prepareFile(filePath, '/bench', { byHashOnly: true })
const newMs = Date.now() - t0
const newStats = { ...chunkStats }
setChunkStats(false)

console.log(JSON.stringify({
  sizeMB,
  tier,
  chunks: result.chunks.length,
  old_64KiB: { wallMs: oldMs, MBps: round(sizeMB / (oldMs / 1000)), concatPerByte: round(oldStats.concatBytes / sizeBytes), copyPerByte: round(oldStats.copyBytes / sizeBytes), blocks: oldStats.blocks },
  new_block: { wallMs: newMs, MBps: round(sizeMB / (newMs / 1000)), concatPerByte: round(newStats.concatBytes / sizeBytes), copyPerByte: round(newStats.copyBytes / sizeBytes), blocks: newStats.blocks },
  speedup: round(oldMs / newMs)
}, null, 2))

await index.close()
await store.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
