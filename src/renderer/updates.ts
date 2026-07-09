import type { UpdateInfo } from './types.js'
import { initialUpdateState, reduceDetectedUpdate, reduceDismissed } from './updateState.js'

interface UpdateState {
  update: UpdateInfo | null
  dismissed: boolean
}

type Listener = (state: UpdateState) => void

let state: UpdateState = initialUpdateState
const listeners = new Set<Listener>()

function emit(): void {
  for (const cb of listeners) cb(state)
}

interface VersionResponse {
  fork?: number
  length?: number
  semver?: string | null
}

async function fetchVersion(): Promise<{ fork: number; length: number; semver: string | null }> {
  // Read directly from main (pear.updater.drive) instead of going through the
  // worker. The worker captures fork/length once at bootstrap, which can be
  // 0/0 before any replication completes — the banner would render that stale
  // snapshot as "v0.0". Main can read the live drive head and the staged
  // package.json semver (what the banner actually shows) at any time.
  try {
    const res: VersionResponse = await window.bridge.appVersion()
    return {
      fork: typeof res.fork === 'number' ? res.fork : 0,
      length: typeof res.length === 'number' ? res.length : 0,
      semver: typeof res.semver === 'string' ? res.semver : null,
    }
  } catch {
    return { fork: 0, length: 0, semver: null }
  }
}

if (typeof window !== 'undefined' && typeof window.bridge !== 'undefined') {
  window.bridge.onPearEvent('updated', async () => {
    if (window.bridge.isDev()) {
      try { location.reload() } catch {}
      return
    }
    const version = await fetchVersion()
    state = reduceDetectedUpdate(state, version)
    emit()
  })
}

export function getUpdateState(): UpdateState {
  return state
}

export function onUpdateState(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function dismissUpdate(): void {
  const next = reduceDismissed(state)
  if (next === state) return
  state = next
  emit()
}
