// Spike S2 driver — seeds a throwaway upgrade drive on a hermetic testnet and runs the Bare stager
// against it. Node, not shipped.
//
//   node scripts/spikes/s2-seed.mjs [--size BYTES] [--executable] [--bundle] [--name NAME]
//        [--app PATH] [--dir DIR] [--apply] [--data-store] [--version V]
//
// `--bundle` seeds a directory bundle (<name>/Contents/MacOS/<name>) instead of a single file;
// `--app` names the installed artefact the stager may swap; both default to scratch copies.
import { spawn, execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import hid from 'hypercore-id-encoding'
import { platform, arch } from 'which-runtime'
import { flag as readFlag, bareBinaryRelative, vmRssKb } from './lib.mjs'

const args = process.argv.slice(2)
const flag = (name, dflt) => readFlag(args, name, dflt)
const size = Number(flag('--size', String(1 << 20)))
const executable = args.includes('--executable')
const bundle = args.includes('--bundle')
const name = flag('--name', bundle ? 'Mirall.app' : 'Mirall.AppImage')
const here = path.dirname(fileURLToPath(import.meta.url))
const bare = path.resolve(here, bareBinaryRelative(process.platform, process.arch))
const tmp = fs.realpathSync(os.tmpdir())
const ownDir = flag('--dir', null) === null
const dir = flag('--dir', null) || fs.mkdtempSync(path.join(tmp, 's2-dir-'))
const app = path.resolve(flag('--app', null) || path.join(dir, name))
const host = `${platform}-${arch}`

// `--apply` swaps the real artefact and deletes what it replaced. Outside the scratch dir that is
// an installed app, so it takes an explicit second flag.
if (args.includes('--apply') && !app.startsWith(dir + path.sep) && !args.includes('--apply-outside-dir')) {
  console.error(`refusing --apply on ${app}: outside ${dir}; pass --apply-outside-dir to swap an installed artefact`)
  if (ownDir) fs.rmSync(dir, { recursive: true, force: true })
  process.exit(2)
}

fs.mkdirSync(dir, { recursive: true })
if (!fs.existsSync(app)) {
  if (bundle) { fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true }); fs.writeFileSync(path.join(app, 'Contents', 'MacOS', name), 'old') } else fs.writeFileSync(app, 'old')
}

const testnet = await createTestnet(3)
const seedDir = fs.mkdtempSync(path.join(tmp, 's2-seed-'))
const seedStore = new Corestore(seedDir)
const drive = new Hyperdrive(seedStore)
await drive.ready()
await drive.put('/package.json', Buffer.from(JSON.stringify({ name: 'mirall', version: flag('--version', '9.9.9') })))
const payload = bundle ? `/by-arch/${host}/app/${name}/Contents/MacOS/${name}` : `/by-arch/${host}/app/${name}`
const ws = drive.createWriteStream(payload, { executable })
for (let left = size; left > 0; left -= 1 << 20) {
  const n = Math.min(left, 1 << 20)
  if (!ws.write(crypto.randomBytes(n))) await new Promise((r) => ws.once('drain', r))
}
await new Promise((resolve, reject) => { ws.once('close', resolve); ws.once('error', reject); ws.end() })

const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
swarm.on('connection', (c) => seedStore.replicate(c))
swarm.join(drive.discoveryKey, { server: true, client: false })
await swarm.flush()
const link = `pear://${hid.encode(drive.key)}`
console.log(JSON.stringify({ seeded: true, host, link, payload, size, executable, bundle, dir, app, bootstrap: testnet.bootstrap }))

const stagerArgs = [path.join(here, 's2-bare-stage.mjs'), dir, link, name, app, '--bootstrap', JSON.stringify(testnet.bootstrap), '--version', '0.0.1']
for (const f of ['--apply', '--data-store']) if (args.includes(f)) stagerArgs.push(f)
const stager = spawn(bare, stagerArgs, { stdio: ['ignore', 'pipe', 'inherit'] })
let pid = null
let rssPeakKb = 0
const sampler = setInterval(() => {
  if (!pid) return
  try {
    const kb = process.platform === 'linux'
      ? vmRssKb(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))
      : Number(execSync(`ps -o rss= -p ${pid}`).toString().trim())
    if (kb > rssPeakKb) rssPeakKb = kb
  } catch {}
}, 200)
const rl = readline.createInterface({ input: stager.stdout })
rl.on('line', (l) => {
  console.log('stager', l)
  try { const ev = JSON.parse(l); if (ev.loaded) pid = ev.pid } catch {}
})
const code = await new Promise((r) => stager.on('exit', r))
clearInterval(sampler)
console.log(JSON.stringify({ stagerExit: code, rssPeakKb }))

await swarm.destroy()
await drive.close()
await seedStore.close()
await testnet.destroy()
fs.rmSync(seedDir, { recursive: true, force: true })
if (ownDir) fs.rmSync(dir, { recursive: true, force: true })
process.exit(code === 0 ? 0 : 1)
