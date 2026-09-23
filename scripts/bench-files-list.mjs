// Benchmark one files:list over M peer members × N loose rows, a fraction d of them downloaded and
// verified on disk. Each member's catalog is a local bee, so the numbers are the listing's own cost
// with no network in them: `rowPath` re-reads every catalog on every listing, `memo` runs with the
// default backstop, where most listings are served from the memo.
// Run under bare:  bare scripts/bench-files-list.mjs [M=12] [N=2000] [d=0.25] [runs=20]
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { freshPeer } from '../test/helpers/store.js'
import { getListFullReadEvery, getRuntimeConfig, setRuntimeConfig } from '../src/shared/core/runtime-config.js'
import { createBee } from '../src/shared/core/store.js'
import { createSpace } from '../src/shared/spaces/space-lifecycle.js'
import { initDownloads, markDownloaded, markVerified } from '../src/shared/transfer/files.js'
import { initPendingTransfers } from '../src/shared/transfer/pending-transfers.js'
import { listFiles } from '../src/shared/transfer/file-listing.js'
import { LOOSE_SHARE_ID } from '../src/shared/transfer/transfer-id.js'

const M = Number(Bare.argv[2] || 12)
const N = Number(Bare.argv[3] || 2000)
const d = Number(Bare.argv[4] || 0.25)
const runs = Number(Bare.argv[5] || 20)

const teardowns = []
const harness = { teardown: (fn, { order = 0 } = {}) => teardowns.push({ fn, order }) }

const ctx = await freshPeer(harness)
setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
await initDownloads()
await initPendingTransfers()
const { spaceId } = await createSpace('Bench')
const downloads = ctx.tmpDir('bench-dl')

const hashOf = (m, j) => b4a.toString(b4a.from(`${m}:${j}`.padEnd(32, '.')), 'hex')

async function catalogMember(m) {
  const bee = createBee('bench-catalog-' + m)
  await bee.ready()
  const batch = bee.batch()
  for (let j = 0; j < N; j++) {
    await batch.put('file/' + LOOSE_SHARE_ID + `/m${m}-f${j}.bin`, { size: 8, mtime: 1, contentHash: hashOf(m, j) })
  }
  await batch.flush()
  const key = b4a.toString(bee.core.key, 'hex')
  await bee.close()
  return { publicKey: 'bench' + m + 'pub', driveKey: null, displayName: 'M' + m, looseCatalogKey: key }
}

async function landDownload(m, j) {
  const name = `m${m}-f${j}.bin`
  const landed = path.join(downloads, name)
  fs.writeFileSync(landed, 'eightbyt')
  await markDownloaded(spaceId, '/' + name, landed, { hash: hashOf(m, j) })
  await markVerified(spaceId, LOOSE_SHARE_ID + '|' + name, hashOf(m, j), { local: landed, stat: fs.statSync(landed) })
}

const members = []
for (let m = 0; m < M; m++) {
  members.push(await catalogMember(m))
  for (let j = 0; j < Math.floor(N * d); j++) await landDownload(m, j)
}

const timed = async () => {
  const t0 = Date.now()
  const rows = await listFiles(spaceId, members)
  return { ms: Date.now() - t0, rows: rows.length }
}

async function warmRuns(listFullReadEvery) {
  setRuntimeConfig({ ...getRuntimeConfig(), listFullReadEvery })
  await timed()
  await timed()
  const warm = []
  for (let i = 0; i < runs; i++) warm.push((await timed()).ms)
  warm.sort((a, b) => a - b)
  return { medianMs: warm[Math.floor(warm.length / 2)], p95Ms: warm[Math.min(warm.length - 1, Math.ceil(warm.length * 0.95) - 1)] }
}

const backstop = getListFullReadEvery()
const cold = await timed()
const rowPath = await warmRuns(1)
const memo = await warmRuns(backstop)

console.log(JSON.stringify({ M, N, d, runs, rows: cold.rows, coldMs: cold.ms, rowPath, memo }))

teardowns.sort((a, b) => a.order - b.order)
for (const { fn } of teardowns) await fn()
