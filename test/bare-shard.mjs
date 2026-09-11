// Partitions test/integration/*.test.js across CI shards, so one file's hard failure fails one
// shard instead of the suite and the 200 files spread over more than one runner.
//
// The weight is the file's size in bytes, greedily assigned longest-first. It is a proxy, not a
// measurement — but it is a proxy nothing has to maintain, and the shards only have to be roughly
// even: their job is isolation, and the runner already parallelises inside each one.
//
// Usage: node test/bare-shard.mjs <1-based shardIndex> <shardTotal>
import { readdirSync, statSync } from 'fs'
import path from 'path'

const index = Number(process.argv[2])
const total = Number(process.argv[3])
if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
  console.error('usage: node test/bare-shard.mjs <1-based shardIndex> <shardTotal>')
  process.exit(1)
}

const dir = 'test/integration'
const files = readdirSync(path.resolve(dir)).filter((f) => f.endsWith('.test.js')).sort()
const weightOf = (f) => statSync(path.join(dir, f)).size

const load = Array.from({ length: total }, () => 0)
const buckets = Array.from({ length: total }, () => [])
for (const f of [...files].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b))) {
  let lightest = 0
  for (let i = 1; i < total; i++) if (load[i] < load[lightest]) lightest = i
  buckets[lightest].push(f)
  load[lightest] += weightOf(f)
}

process.stdout.write(buckets[index - 1].sort().map((f) => path.join(dir, f)).join(' '))
