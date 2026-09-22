// Spike S2 — pear-runtime-updater staging from a Bare process with no Electron in it. Not shipped.
//
//   bare scripts/spikes/s2-bare-stage.mjs <dir> <upgrade-link> <name> <app-path> --bootstrap JSON
//        [--version V] [--apply] [--data-store]
//
// Constructed the way src/main/updater.js builds the runtime, minus the Electron parts. Prints
// NDJSON lifecycle lines; s2-seed.mjs drives it against a hermetic testnet.
import path from 'bare-path'
import fs from 'bare-fs'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import PearRuntimeUpdater from 'pear-runtime-updater'
import { flag as readFlag, line, errorCode, vmRssKb } from './lib.mjs'

const [dir, upgrade, name, app, ...rest] = Bare.argv.slice(2)
const flag = (key, dflt) => readFlag(rest, key, dflt)
const apply = rest.includes('--apply')
const withDataStore = rest.includes('--data-store')
const bootstrap = JSON.parse(flag('--bootstrap', '[]'))
const version = flag('--version', '0.0.1')

function rssKb() {
  try { return vmRssKb(fs.readFileSync('/proc/self/status', 'utf8')) } catch { return null }
}
function walk(p, acc = { files: 0, bytes: 0, asar: [] }) {
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, ent.name)
    if (ent.isDirectory()) walk(full, acc)
    else { acc.files++; acc.bytes += fs.statSync(full).size; if (/\.asar/i.test(ent.name)) acc.asar.push(full) }
  }
  return acc
}

fs.mkdirSync(dir, { recursive: true })
line({ loaded: true, pid: Bare.pid, platform: Bare.platform, arch: Bare.arch, bare: Bare.version })

const dataStore = withDataStore ? new Corestore(path.join(dir, 'app-storage')) : null
if (dataStore) { await dataStore.ready(); line({ dataStoreOpen: true }) }

const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
const swarm = new Hyperswarm({ bootstrap })
swarm.on('connection', (c) => store.replicate(c))
const u = new PearRuntimeUpdater({ dir, app, bundled: true, updates: true, version, upgrade, name, store, swarm, delay: 0 })
let tUpdating = null
u.on('updating', () => { tUpdating = Date.now(); line({ ev: 'updating', rssKb: rssKb() }) })
u.on('updated', () => line({ ev: 'updated', stageMs: Date.now() - tUpdating, rssKb: rssKb() }))
u.on('update-scheduled', (d) => line({ ev: 'update-scheduled', delay: d }))
u.on('error', (err) => line({ ev: 'error', error: errorCode(err) }))
u.on('updating-progress', (s) => line({ ev: 'progress', ...s, rssKb: rssKb() }))

await u.ready()
swarm.join(u.drive.core.discoveryKey, { client: true, server: false })
await swarm.flush()
line({ ready: true, key: u.drive.key.toString('hex'), peers: swarm.connections.size })

await u._debouncedUpdate()
const deadline = Date.now() + 120_000
while (!u.updated && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
line({ staged: u.updated, next: u.next, nextVersion: u.nextVersion })
let applied = !apply

if (u.updated) {
  const host = `${Bare.platform}-${Bare.arch}`
  const nextApp = path.join(u.next, 'by-arch', host, 'app', name)
  const st = fs.statSync(nextApp)
  line({ nextApp, isDirectory: st.isDirectory(), mode: (st.mode & 0o777).toString(8), size: st.size, staged: walk(u.next) })
  if (apply) {
    try {
      await u.applyUpdate()
      applied = true
      const after = fs.statSync(app)
      line({ applied: true, appMode: (after.mode & 0o777).toString(8), appSize: after.size, appIsDirectory: after.isDirectory(), nextRemoved: !fs.existsSync(u.next) })
    } catch (err) { line({ applied: false, error: errorCode(err) }) }
  }
}

await u.close()
await swarm.destroy()
await store.close()
if (dataStore) await dataStore.close()
const ok = u.updated && applied
line({ done: true, ok })
Bare.exit(ok ? 0 : 1)
