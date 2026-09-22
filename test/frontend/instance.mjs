import { spawn } from 'node:child_process'
import { rmSync, openSync, closeSync } from 'node:fs'
import { ad } from './agent.mjs'
import { tile } from './layout.mjs'
import { workDir } from './paths.mjs'
import { POLL_MS, mirallWindows, REPO, STORE_RELEASE_TIMEOUT_MS, storeHeldByApp } from './ax-support.mjs'

import { withAx } from './ax.mjs'
import { withFlows } from './flows.mjs'

class InstanceBase {
  constructor({ name, bootstrap = null, slot = 0, total = 2, flags = null, env = null }) {
    this.name = name
    this.bootstrap = bootstrap
    this.slot = slot
    this.total = total
    // Merged over feature-flags.json via MIRALL_FEATURE_FLAGS.
    this.flags = { ...(flags || {}) }
    // Extra MIRALL_* hooks for this instance's process only, so one peer can differ from the rest.
    this.env = { ...(env || {}) }
    this.store = workDir(`store-${name}-`)
    this.downloadFolder = workDir(`dl-${name}-`)
    this.proc = null
    this.windowId = null
    this.pid = null
    // agent-desktop 0.3.0+ resolves a ref against the latest snapshot saved in its
    // --session namespace, so snapshot-then-act across separate CLI processes only
    // stays coherent when both share one session. Give each Instance its own
    // namespace (id sanitised to [A-Za-z0-9_-], <=64 chars) so two peers' snapshots
    // never clobber each other's latest. this.ad threads the session onto snapshots
    // and ref-consuming actions (the calls whose ref must resolve cross-process).
    this.session = `mirall-${name}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
    this.ad = (a, opts = {}) => ad(a, { session: this.session, ...opts })
  }

  async launch({ onboard = true } = {}) {
    const before = new Set((await mirallWindows()).map((w) => w.id))
    const env = {
      ...process.env,
      MIRALL_NO_DEVTOOLS: '1',
      MIRALL_FORCE_A11Y: '1',
      MIRALL_VERBOSE: '1',
      MIRALL_DOWNLOAD_FOLDER: this.downloadFolder,
      MIRALL_WINDOW_BOUNDS: JSON.stringify(tile(this.slot, this.total)),
      ...this.env,
    }
    if (this.bootstrap) env.MIRALL_DHT_BOOTSTRAP = JSON.stringify(this.bootstrap)
    if (this.flags) env.MIRALL_FEATURE_FLAGS = JSON.stringify(this.flags)
    this.logPath = `/tmp/mirall-fe-${this.name}.log`
    const logFd = openSync(this.logPath, 'w')
    this.proc = spawn(
      'npx',
      ['electron-forge', 'start', '--', '--no-updates', '--storage', this.store],
      { cwd: REPO, env, detached: true, stdio: ['ignore', logFd, logFd] },
    )
    // The child dup'd its own copy of the log fd; close ours so 82 sequential
    // launches in a full run don't leak 82 descriptors in the test runner.
    closeSync(logFd)

    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const fresh = (await mirallWindows()).filter((w) => !before.has(w.id))
      if (fresh.length) {
        this.windowId = fresh[fresh.length - 1].id
        this.pid = fresh[fresh.length - 1].pid
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!this.windowId) throw new Error(`${this.name}: Mirall window never appeared`)
    console.error(`[${this.name}] before=[${[...before].join(',')}] resolved=${this.windowId}`)
    // Raise the new window so Chromium paints it; a backgrounded renderer never
    // builds its AX tree, which leaves snapshots empty. Unconditional (not via
    // focus()) because focus() no-ops for single instances — the one-time initial
    // raise must still happen so the renderer paints and snapshots aren't empty.
    await ad(['focus-window', '--window-id', this.windowId], { allowError: true })
    await this._waitForAx()
    if (onboard) await this.onboard()
    return this
  }

  // Chromium attaches a renderer's AX tree lazily, so a window can be listed and painted a beat
  // before it answers an AX query (ACTION_NOT_SUPPORTED). Block until it does, so every scenario
  // starts from a window that is known to be drivable.

  moveCursorAway() {
    return this.ad(['mouse-move', '--xy', '5,5'], { allowError: true, headed: true })
  }

  // agent-desktop `type` double-emits keystrokes on these React inputs; `set-value`
  // sets the value once and still fires React's onChange (verified). It returns a
  // spurious ACTION_FAILED even on success, so allow the error and verify by read-back.

  async _stopProcess({ hard = false } = {}) {
    const proc = this.proc
    this.proc = null
    if (!proc?.pid) return
    const exited = new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      proc.once('exit', resolve)
      proc.once('error', resolve)
    })
    if (hard) {
      try { process.kill(-proc.pid, 'SIGKILL') } catch {}
      await exited
      await this._awaitStoreRelease(proc.pid)
      return
    }
    try { process.kill(-proc.pid, 'SIGTERM') } catch {}
    const sigkill = setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL') } catch {} }, 6000)
    await exited
    clearTimeout(sigkill)
    await this._awaitStoreRelease(proc.pid)
  }

  // The wrapper's `exit` says nothing about the Electron process it spawned, which is still running
  // before-quit at that point. That matters because main's ConfigStore is debounced and flushed on
  // quit, and the flush rewrites the WHOLE config.json from main's in-memory object — window bounds
  // are written as the window closes, so the flush is armed even when the scenario changed nothing.
  // Resolving here while that is in flight lets a caller's edit be silently replaced. Wait until no
  // process holds the store, SIGKILLing the group once more if one is wedged.

  async _awaitStoreRelease(groupPid) {
    if (!storeHeldByApp(this.store)) return
    const deadline = Date.now() + STORE_RELEASE_TIMEOUT_MS
    let escalated = false
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS))
      if (!storeHeldByApp(this.store)) return
      if (!escalated && Date.now() > deadline - STORE_RELEASE_TIMEOUT_MS / 2) {
        escalated = true
        try { process.kill(-groupPid, 'SIGKILL') } catch {}
      }
    }
    throw new Error(`${this.name}: Electron still holds ${this.store} ${STORE_RELEASE_TIMEOUT_MS}ms after exit`)
  }

  async kill() {
    await this._stopProcess()
    // Only now is nothing still writing the store — safe to remove it.
    try {
      rmSync(this.store, { recursive: true, force: true })
      rmSync(this.downloadFolder, { recursive: true, force: true })
    } catch {}
  }

  // Quit this instance's process but KEEP its store + download folder, then boot a
  // fresh process on the SAME store — the returning-user path (no onboarding). This
  // is how restart-recovery scenarios (quit mid-transfer / mid-index → relaunch →
  // resume / recover) are exercised at the UI layer; plain kill() wipes the store and
  // can't. `hard:true` force-quits (SIGKILL) to interrupt an in-flight operation
  // abruptly — a crash rather than a clean shutdown; default is a graceful SIGTERM
  // (faster owner-offline detection for the peer). The agent-desktop session
  // namespace is unchanged, so cross-process refs keep resolving against the fresh
  // window's snapshots. Caller waits for the post-boot content it expects (the space
  // view loads straight into the existing membership — no Welcome screen).
  // Stop this instance's process but KEEP its store + download folder (the offline half of a
  // restart, with a caller-controlled gap). Pair with launch({ onboard:false }) to bring it
  // back AFTER the peer has observed the outage — the offline→online edge that owner-return
  // auto-resume needs (a no-gap relaunch can come back before the peer ever saw it leave).

  async quit({ hard = false } = {}) {
    await this._stopProcess({ hard })
    this.windowId = null
    this.pid = null
  }

  async relaunch({ hard = false } = {}) {
    await this.quit({ hard })
    return this.launch({ onboard: false })
  }
}

export const Instance = withFlows(withAx(InstanceBase))
