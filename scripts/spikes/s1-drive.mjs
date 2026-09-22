// Spike S1 driver — runs the mutation matrix against s1-bare-watch.mjs and scores it. Node, not
// shipped.
//
//   node scripts/spikes/s1-drive.mjs [--mode native|tree] [--out DIR] [--files N] [--inotify-limit N]
//
// Every mutation and every watcher event carries the same wall clock, so a mutation is scored by
// the first event on its exact path at or after it. The output directory gets the raw NDJSON logs
// and a summary.json; the table on stdout is the same summary.
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { flag as readFlag, bareBinaryRelative, vmRssKb } from './lib.mjs'

const args = process.argv.slice(2)
const flag = (name, dflt) => readFlag(args, name, dflt)
const mode = flag('--mode', 'native')
const out = path.resolve(flag('--out', path.join(os.tmpdir(), `s1-${mode}-${Date.now()}`)))
const fileCount = Number(flag('--files', '5000'))
const inotifyLimit = flag('--inotify-limit', null)
const here = path.dirname(fileURLToPath(import.meta.url))
const bare = path.resolve(here, bareBinaryRelative(process.platform, process.arch))

const tmp = fs.realpathSync(os.tmpdir())
const root = fs.mkdtempSync(path.join(tmp, 's1-root-'))
const outside = fs.mkdtempSync(path.join(tmp, 's1-outside-'))
fs.mkdirSync(out, { recursive: true })

const events = []
const mutations = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()

function mutate(kase, op, target, fn) {
  const t = now()
  fn()
  mutations.push({ t, case: kase, op, path: target })
}

const watcher = spawn(bare, [path.join(here, 's1-bare-watch.mjs'), root, '--mode', mode], { stdio: ['ignore', 'pipe', 'inherit'] })
const rl = readline.createInterface({ input: watcher.stdout })
let ready = null
const readyP = new Promise((r) => { ready = r })
rl.on('line', (l) => {
  let ev
  try { ev = JSON.parse(l) } catch { return }
  events.push(ev)
  if (ev.ready) ready(ev)
})
function cleanupTmp() {
  for (const p of [root, outside]) fs.rmSync(p, { recursive: true, force: true })
}
// A watcher that dies before `ready` (no bare binary, a module error) must not hang the driver.
const readyLine = await Promise.race([
  readyP,
  new Promise((_, reject) => {
    watcher.on('error', reject)
    watcher.on('exit', (code, signal) => reject(new Error(`watcher exited before ready (${signal || code})`)))
  }),
]).catch((err) => { cleanupTmp(); console.error(err.message); process.exit(1) })
const pid = readyLine.pid

function rssKb() {
  try {
    if (process.platform === 'linux') return vmRssKb(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))
    return Number(execSync(`ps -o rss= -p ${pid}`).toString().trim())
  } catch { return null }
}
// The kernel's own count of live watches, as opposed to the handles the watcher believes it holds.
function inotifyWatches() {
  if (process.platform !== 'linux') return null
  let n = 0
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fdinfo`)) {
      try { n += (fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').match(/^inotify wd:/gm) || []).length } catch {}
    }
  } catch { return null }
  return n
}
const INOTIFY_MAX = '/proc/sys/fs/inotify/max_user_watches'
const readLimit = () => { try { return fs.readFileSync(INOTIFY_MAX, 'utf8').trim() } catch { return null } }

const facts = { ...readyLine, node: process.version, kernel: os.release(), inotifyMaxUserWatches: readLimit(), rssStartKb: rssKb() }
const dir = (...p) => path.join(root, ...p)
const mk = (p) => fs.mkdirSync(p, { recursive: true })
const write = (p, data = 'x') => fs.writeFileSync(p, data)
const notes = {}

// M1 — nested create, file written at once and after the tree has had time to arm.
mk(dir('m1'))
mutate('M1', 'mkdir+write', dir('m1', 'a', 'b', 'c', 'd', 'e', 'f.txt'), () => { mk(dir('m1', 'a', 'b', 'c', 'd', 'e')); write(dir('m1', 'a', 'b', 'c', 'd', 'e', 'f.txt')) })
await sleep(1000)
mk(dir('m1b', 'a', 'b', 'c', 'd', 'e'))
await sleep(250)
mutate('M1b', 'write-after-arm', dir('m1b', 'a', 'b', 'c', 'd', 'e', 'f.txt'), () => write(dir('m1b', 'a', 'b', 'c', 'd', 'e', 'f.txt')))
await sleep(1000)

// M2 — a burst of files across pre-armed directories.
const dirs = 200
for (let i = 0; i < dirs; i++) mk(dir('m2', `d${String(i).padStart(3, '0')}`))
await sleep(1000)
notes.m2RssBeforeKb = rssKb()
const m2t0 = now()
for (let i = 0; i < fileCount; i++) {
  const p = dir('m2', `d${String(i % dirs).padStart(3, '0')}`, `f${i}.txt`)
  mutate('M2', 'write', p, () => write(p))
  // Yield so the watcher's stdout pipe drains during the burst; a full pipe blocks the watcher and
  // the latency would measure the driver, not delivery.
  if (i % 256 === 0) await new Promise((r) => setImmediate(r))
}
notes.m2WriteMs = now() - m2t0
await sleep(3000)
notes.m2RssAfterKb = rssKb()
notes.m2InotifyWatches = inotifyWatches()

// M3 — rename a directory inside the root, then write under the new name.
mk(dir('m3', 'a', 'b', 'c')); write(dir('m3', 'a', 'b', 'c', 'f.txt'))
await sleep(500)
mutate('M3', 'rename-dir', dir('m3', 'a', 'bb'), () => fs.renameSync(dir('m3', 'a', 'b'), dir('m3', 'a', 'bb')))
await sleep(500)
mutate('M3', 'write-under-renamed', dir('m3', 'a', 'bb', 'c', 'g.txt'), () => write(dir('m3', 'a', 'bb', 'c', 'g.txt')))
await sleep(1000)

// M4 — move a directory out of the root and back, then write in it.
mk(dir('m4', 'a', 'b')); write(dir('m4', 'a', 'b', 'f.txt'))
await sleep(500)
mutate('M4', 'move-out', dir('m4', 'a', 'b'), () => fs.renameSync(dir('m4', 'a', 'b'), path.join(outside, 'b')))
await sleep(500)
mutate('M4', 'move-in', dir('m4', 'a', 'b'), () => fs.renameSync(path.join(outside, 'b'), dir('m4', 'a', 'b')))
await sleep(500)
mutate('M4', 'write-after-move-in', dir('m4', 'a', 'b', 'h.txt'), () => write(dir('m4', 'a', 'b', 'h.txt')))
await sleep(1000)

// M5 — delete a subtree; every file should be reported and no watcher should leak.
const m5files = []
for (const d of ['b', 'c']) { mk(dir('m5', 'a', d)); for (let i = 0; i < 10; i++) { const p = dir('m5', 'a', d, `f${i}.txt`); write(p); m5files.push(p) } }
await sleep(800)
notes.m5WatchedBefore = lastWatched()
const t5 = now()
fs.rmSync(dir('m5', 'a'), { recursive: true })
for (const p of m5files) mutations.push({ t: t5, case: 'M5', op: 'rm-rf', path: p })
await sleep(1500)
notes.m5WatchedAfter = lastWatched()

// M6 — one large file written in small chunks.
mk(dir('m6'))
const big = dir('m6', 'big.bin')
const chunk = Buffer.alloc(4096, 7)
const fd = fs.openSync(big, 'w')
mutations.push({ t: now(), case: 'M6', op: 'write-200mb', path: big })
const m6t0 = now()
for (let i = 0; i < 51200; i++) {
  fs.writeSync(fd, chunk)
  if (i % 256 === 0) await new Promise((r) => setImmediate(r))
}
fs.closeSync(fd)
notes.m6WriteMs = now() - m6t0
await sleep(1500)

// M7 — the rename-over save: write a temp file, rename it over the target.
mk(dir('m7')); write(dir('m7', 'x'), 'old')
await sleep(500)
const m7t0 = now()
write(dir('m7', 'x.tmp'), 'new')
mutate('M7', 'rename-over', dir('m7', 'x'), () => fs.renameSync(dir('m7', 'x.tmp'), dir('m7', 'x')))
await sleep(1000)
notes.m7Sequence = events.filter((e) => e.t >= m7t0 && e.path && e.path.startsWith(dir('m7'))).map((e) => `${e.eventType} ${path.basename(e.path)}`)

// M8 — a symlinked directory must not be followed.
mk(dir('m8'))
const elsewhere = fs.mkdtempSync(path.join(tmp, 's1-elsewhere-'))
fs.symlinkSync(elsewhere, dir('m8', 'link'))
await sleep(500)
const m8t0 = now()
write(path.join(elsewhere, 's.txt'))
await sleep(1000)
notes.m8FollowedSymlink = events.some((e) => e.t >= m8t0 && e.path && (e.path.includes(elsewhere) || e.path.includes(path.join('m8', 'link', 's.txt'))))

// M9 — the inotify watch limit, only when the driver may lower it. The runtime reports nothing
// past the limit, so the kernel's count is diffed against the handles the tree believes it holds,
// and a write under a late-armed directory shows whether that handle is live.
if (inotifyLimit && process.platform === 'linux') {
  const previous = readLimit()
  try {
    try { fs.writeFileSync(INOTIFY_MAX, String(inotifyLimit)) } catch {}
    notes.m9Limit = { previous, applied: readLimit(), uid: process.getuid?.() ?? null }
    const m9t0 = now()
    for (let i = 0; i < 2000; i++) mk(dir('m9', `d${i}`))
    await sleep(3000)
    notes.m9Errors = [...new Set(events.filter((e) => e.t >= m9t0 && e.error).map((e) => e.error))]
    notes.m9Closed = events.filter((e) => e.t >= m9t0 && e.closed).length
    notes.m9TreeBelieves = lastWatched()
    notes.m9KernelWatches = inotifyWatches()
    mutate('M9-early', 'write-on-early-armed-dir', dir('m1b', 'a', 'still.txt'), () => write(dir('m1b', 'a', 'still.txt')))
    mutate('M9-late', 'write-on-late-armed-dir', dir('m9', 'd1999', 'dead.txt'), () => write(dir('m9', 'd1999', 'dead.txt')))
    await sleep(1000)
  } finally {
    try { fs.writeFileSync(INOTIFY_MAX, previous) } catch {}
  }
}

await sleep(3000)
notes.rssEndKb = rssKb()
notes.crashed = watcher.exitCode !== null
watcher.kill('SIGTERM')

function lastWatched() {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].watched !== undefined) return events[i].watched
  return null
}
function pct(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null }

const byCase = {}
for (const m of mutations) {
  const c = byCase[m.case] ||= { expected: 0, hits: 0, latencies: [], eventsOnPath: 0 }
  c.expected++
  const hit = events.find((e) => e.path === m.path && e.t >= m.t)
  if (hit) { c.hits++; c.latencies.push(hit.t - m.t) }
  c.eventsOnPath += events.filter((e) => e.path === m.path && e.t >= m.t).length
}
const summary = {}
for (const [k, c] of Object.entries(byCase)) {
  const s = c.latencies.sort((a, b) => a - b)
  summary[k] = { expected: c.expected, hits: c.hits, hitRate: +(c.hits / c.expected).toFixed(4), p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.at(-1) ?? null, eventsPerMutation: +(c.eventsOnPath / c.expected).toFixed(2) }
}
const result = { mode, facts, cases: summary, notes, totalEvents: events.length, errors: [...new Set(events.filter((e) => e.error).map((e) => e.error))] }
fs.writeFileSync(path.join(out, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
fs.writeFileSync(path.join(out, 'mutations.ndjson'), mutations.map((e) => JSON.stringify(e)).join('\n') + '\n')
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ mode, platform: facts.platform, arch: facts.arch, out }))
console.table(summary)
console.log(JSON.stringify(notes, null, 2))
cleanupTmp()
fs.rmSync(elsewhere, { recursive: true, force: true })
process.exit(0)
