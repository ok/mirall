// Module-scope helpers the three halves of Instance share: the agent-desktop client, the AX tree
// walkers, the retry policy and the window filter. They live here because all three files need
// them and none of the three owns them.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { ad } from './agent.mjs'

export const REPO = path.resolve(import.meta.dirname, '../..')

// `electron-forge start` runs unbranded, so our dev windows surface under
// app_name "Electron" (real Electron apps like Signal/Keet report their
// productName). We deliberately do NOT match on `title`: list-windows fills
// `title` from CGWindow's kCGWindowName, which is only populated when the
// caller holds Screen Recording permission — without it the title falls back
// to the owner name ("Electron"), not the document title ("Mirall"), and the
// whole suite stalls for 90s per launch waiting for a window that never
// matches. Snapshots only need Accessibility, so keying off app_name alone
// drops that second, fragile permission dependency. Native NSOpenPanel /
// NSSavePanel sheets share our pid and app_name but carry their own titles, so
// exclude them by title to keep pid-based re-resolution on the main window.
export const NATIVE_PANEL_TITLES = new Set(['Open', 'Save'])

// Poll interval for the harness's own wait loops. Each iteration does a ~0.4s
// snapshot, so the snapshot dominates and a tight sleep just trims dead time
// between polls without spamming the AX system.
export const POLL_MS = 150

// Attempts (and per-attempt wait) for getting a native Open panel on screen; the
// product is the old single 20s budget, so a lost trigger costs no extra wall
// clock on the happy path. See nativeChoosePath.
export const PANEL_TRIES = 3
export const PANEL_WAIT_MS = 7000

// How long to wait, after the `npx electron-forge` wrapper has exited, for the Electron process it
// spawned to actually let go of the store. The graceful path already allows 6s before SIGKILL, so
// this only has to cover the kernel reaping a killed process.
export const STORE_RELEASE_TIMEOUT_MS = 10000

// True while an Electron process still holds `store`. Electron main carries `--storage <store>` in
// its argv; the helper processes (renderer, GPU, utility) do not, so this matches exactly the one
// process that writes config.json.
export function storeHeldByApp(store) {
  const pattern = `Electron.*${store.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export async function mirallWindows() {
  const { data } = await ad(['list-windows'])
  return data
    // `visible` is the property we depend on: helper windows share the pid and answer no AX query.
    .filter((w) => w.app_name === 'Electron' && w.visible === true && !NATIVE_PANEL_TITLES.has(w.title))
    .map((w) => ({ id: w.id, pid: w.pid }))
}

// Process lifecycle only. The AX primitives and the app flows are mixins — three files, one
// class, and the surface the 135 scenarios call is unchanged.
