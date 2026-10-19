// The organization's drive: a read-only replica of its config Hyperbee, kept live by a client-only
// swarm on a DHT node of its own, so closing it releases everything it opened and the organization's
// node never sees the identity the app's own swarm presents. Licensed installs only; the preview
// never opens one.
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import { BUNDLES_SUB, decodeDriveEntry } from './drive-entry.js'

const MIN_PUBLISHED_LENGTH = 2
const FINDING_PEERS_GRACE_MS = 30_000
const UPDATE_STEP_MS = 250

export class DriveSource {
  constructor({ dir, bootstrap = null, driveKey, timers, onChange, log }) {
    Object.assign(this, { dir, bootstrap, driveKey, timers, onChange, log })
    this.store = null
    this.core = null
    this.bee = null
    this.swarm = null
    this.releaseFinding = null
    this.closed = false
  }

  async open() {
    this.store = new Corestore(this.dir)
    this.core = this.store.get({ key: this.driveKey })
    await this.core.ready()
    this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'binary' })
    await this.bee.ready()
    this.swarm = new Hyperswarm(this.bootstrap ? { bootstrap: this.bootstrap } : {})
    this.swarm.on('connection', (socket) => this.store.replicate(socket))
    // Held until the first lookup has flushed and a peer has connected (or the grace passes):
    // released early, update({ wait }) answers at length 0 before any peer was asked.
    const done = this.store.findingPeers()
    let grace = null
    this.releaseFinding = () => {
      if (!this.releaseFinding) return
      this.releaseFinding = null
      this.timers.clear(grace)
      done()
    }
    grace = this.timers.setTimeout(() => this.releaseFinding?.(), FINDING_PEERS_GRACE_MS)
    this.swarm.once('connection', () => this.swarm.flush().then(() => this.releaseFinding?.(), () => this.releaseFinding?.()))
    this.swarm.join(this.core.discoveryKey, { server: false, client: true })
    this.core.download({ start: 0, end: -1 })
    this.core.on('append', () => this.onChange('append'))
    this.core.on('truncate', () => this.onChange('truncate'))
  }

  get peers() {
    return this.swarm?.connections.size ?? 0
  }

  async readBundles({ timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (!this.closed && this.core.length < MIN_PUBLISHED_LENGTH && Date.now() < deadline) {
      await this.waitForUpdate(deadline - Date.now())
    }
    if (this.closed || this.core.length < MIN_PUBLISHED_LENGTH) return []
    const out = []
    try {
      const stream = this.bee.sub(BUNDLES_SUB).createReadStream({}, { wait: true, timeout: Math.max(1, deadline - Date.now()) })
      for await (const { key, value } of stream) {
        const entry = decodeDriveEntry(value)
        if (entry) out.push({ profileId: key, bytes: entry.bundle })
        else this.log.warn('config drive entry skipped: not a v1 entry')
      }
    } catch (err) {
      this.log.warn('config drive read incomplete:', err.message)
    }
    return out
  }

  waitForUpdate(ms) {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(resolve, Math.min(ms, UPDATE_STEP_MS))
      this.core.update({ wait: true }).then(() => { this.timers.clear(timer); resolve() }, () => {})
    })
  }

  async close() {
    this.closed = true
    this.releaseFinding?.()
    this.core?.removeAllListeners('append')
    this.core?.removeAllListeners('truncate')
    await this.swarm?.destroy()
    await this.bee?.close()
    await this.store?.close()
  }
}
