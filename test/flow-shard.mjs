// Partition test/flow/*.test.js across CI shards by approximate runtime (greedy
// longest-processing-time) so heavy files land in different shards and the suite
// parallelises evenly. Weights are coarse CI-second hints; unmapped files use
// DEFAULT_WEIGHT. Usage: node test/flow-shard.mjs <1-based shardIndex> <shardTotal>
import { readdirSync } from 'fs'
import path from 'path'

const index = Number(process.argv[2])
const total = Number(process.argv[3])
if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
  console.error('usage: node test/flow-shard.mjs <1-based shardIndex> <shardTotal>')
  process.exit(1)
}

const WEIGHTS = {
  'offline-delete-guard.test.js': 60,
  'foreign-sync.test.js': 55,
  'share-content-conformance.test.js': 35,
  'membership-presence.test.js': 34,
  'identity-binding.test.js': 22,
  'browse-download.test.js': 18,
  'offline-transfer.test.js': 18,
  'list-files-status.test.js': 18,
  'resume-transfer.test.js': 16,
  'readd-different-content.test.js': 16,
  'leave-no-rejoin-request.test.js': 14,
  'handshake-burst-cliff.test.js': 12,
}
const DEFAULT_WEIGHT = 5
const weightOf = (f) => WEIGHTS[f] ?? DEFAULT_WEIGHT

const dir = 'test/flow'
const files = readdirSync(path.resolve(dir)).filter((f) => f.endsWith('.test.js')).sort()
const load = Array.from({ length: total }, () => 0)
const buckets = Array.from({ length: total }, () => [])
for (const f of [...files].sort((a, b) => weightOf(b) - weightOf(a))) {
  let lightest = 0
  for (let i = 1; i < total; i++) if (load[i] < load[lightest]) lightest = i
  buckets[lightest].push(f)
  load[lightest] += weightOf(f)
}

process.stdout.write(buckets[index - 1].map((f) => path.join(dir, f)).join(' '))
