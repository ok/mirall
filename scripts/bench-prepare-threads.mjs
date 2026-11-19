// Measures the prepare pass on the hash threads against the pass on the worker thread, on one
// file, and checks that both give the same chunk map and content hash. This is the per-platform
// check a platform passes before it joins HASH_THREAD_PLATFORMS (overlay-instance.js).
//
//   bare scripts/bench-prepare-threads.mjs [sizeMB=2048] [reps=3]
//
// On the Bare a release ships (the one inside bare-sidecar, which needs its host pipe on fd 3):
//
//   node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { stdio: ['inherit', 'inherit', 'inherit', 'pipe'] })" \
//     node_modules/bare-sidecar/prebuilds/<platform>-<arch>/bare scripts/bench-prepare-threads.mjs 2048
//
// The fixture stays at <tmpdir>/mirall-bench-threads-<sizeMB>.bin between runs; a size above
// 10240 exercises the largest chunk tier on a real file. The first pass also warms the page cache.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Corestore from 'corestore'
import { FileIndex } from '../src/shared/transfer/overlay/engine/store/file-index.js'
import { prepareForServe, hostReadBlock } from '../src/shared/transfer/overlay/engine/transfer/prepare.js'
import { createHashThreads } from '../src/shared/transfer/overlay/engine/transfer/hash-threads.js'

const sizeMB = Number(Bare.argv[2] || 2048)
const reps = Number(Bare.argv[3] || 3)
const sizeBytes = sizeMB * 1024 * 1024
const filePath = path.join(os.tmpdir(), `mirall-bench-threads-${sizeMB}.bin`)

function ensureFixture() {
  try { if (fs.statSync(filePath).size === sizeBytes) return } catch {}
  const fill = Buffer.allocUnsafe(1024 * 1024)
  let x = 0x9e3779b9
  const fd = fs.openSync(filePath, 'w')
  for (let written = 0; written < sizeBytes; written += fill.length) {
    for (let i = 0; i < fill.length; i += 4) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0
      fill.writeUInt32LE(x, i)
    }
    fs.writeSync(fd, fill, 0, Math.min(fill.length, sizeBytes - written), written)
  }
  fs.closeSync(fd)
}

function sameResult(a, b) {
  if (a.contentHash !== b.contentHash || a.tier !== b.tier || a.chunks.length !== b.chunks.length) return false
  return a.chunks.every((c, i) => c.hash === b.chunks[i].hash && c.offset === b.chunks[i].offset && c.length === b.chunks[i].length)
}

async function timed(index, opts) {
  const cpu = os.threadCpuUsage()
  const started = Date.now()
  const result = await prepareForServe(index, filePath, opts)
  const ms = Date.now() - started
  const used = os.threadCpuUsage(cpu)
  return { result, MBps: Math.round(sizeMB / (ms / 1000)), workerThreadBusy: Math.round((used.user + used.system) / 10 / ms) / 100 }
}

ensureFixture()
const storeDir = path.join(os.tmpdir(), 'mirall-bench-threads-store-' + Date.now())
const store = new Corestore(storeDir)
const index = new FileIndex(store)
await index.ready()
const unavailable = []
const hashThreads = createHashThreads({ blockSize: hostReadBlock(), onUnavailable: (u) => unavailable.push(u.reason) })

const runs = []
let identical = true
for (let rep = 0; rep < reps; rep++) {
  const worker = await timed(index, {})
  const threaded = await timed(index, { hashThreads })
  identical &&= sameResult(worker.result, threaded.result)
  runs.push({ workerThread: { MBps: worker.MBps, busy: worker.workerThreadBusy }, hashThreads: { MBps: threaded.MBps, workerThreadBusy: threaded.workerThreadBusy } })
}
const best = (key) => Math.max(...runs.map((r) => r[key].MBps))
console.log(JSON.stringify({
  bare: Bare.version,
  platform: `${os.platform()}-${os.arch()}`,
  sizeMB,
  readBlockMiB: hostReadBlock() / 1024 / 1024,
  runs,
  bestMBps: { workerThread: best('workerThread'), hashThreads: best('hashThreads') },
  gain: Math.round(best('hashThreads') / best('workerThread') * 100) / 100,
  identical,
  threadsUnavailable: unavailable,
}, null, 2))

await hashThreads.close()
await index.close()
await store.close()
try { fs.rmSync(storeDir, { recursive: true, force: true }) } catch {}
Bare.exit(identical && unavailable.length === 0 ? 0 : 1)
