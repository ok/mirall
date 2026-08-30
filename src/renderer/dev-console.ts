// window.mirall — a small, always-present developer console for live debugging,
// including on production builds. It layers a friendly, discoverable surface
// over the existing plumbing: read-only diagnostics go through the worker RPC
// (`request`) and logging/version live in main (`window.bridge`).
//
// The headline command is verbose(): it flips verbose logging across both the
// worker and main at runtime, no relaunch and no MIRALL_VERBOSE env var. Worker
// stdout is already piped into this console (see ipc.ts), so once verbose is on
// the worker's debug stream prints right here.
import { request } from './ipc.js'
import type { MirallDevConsole } from './global'

type Cmd = { command: string; description: string }

const COMMANDS: Cmd[] = [
  { command: 'verbose(on = true)', description: 'Toggle verbose logging (worker + main) live. verbose(false) to silence.' },
  { command: 'status()', description: 'Swarm / network status (connections, peers).' },
  { command: 'spaces()', description: 'List known spaces.' },
  { command: 'members(spaceId)', description: 'Connected members of a space (pass a spaceId from spaces()).' },
  { command: 'storage()', description: 'Local storage usage.' },
  { command: 'audit(opts)', description: 'Recent audit-log rows. Pass e.g. {spaceId, limit} to narrow.' },
  { command: 'mounts()', description: 'All mounted drives.' },
  { command: 'profile()', description: 'This peer’s profile / identity.' },
  { command: 'features()', description: 'Enabled feature flags.' },
  { command: 'version()', description: 'App version (drive length / fork / semver).' },
  { command: 'update()', description: 'Trigger the OTA update lookup now (debounced).' },
  { command: 'identity()', description: 'Identity-at-rest protection level.' },
  { command: 'help()', description: 'Show this list.' },
]

function help(): void {
  console.log('%cwindow.mirall%c — Mirall developer console', 'font-weight:bold', 'font-weight:normal')
  const table: Record<string, string> = {}
  for (const c of COMMANDS) table[c.command] = c.description
  console.table(table)
}

// Run a read-only worker query, log the result with a label, and return it so
// the value is also usable from the console (e.g. `await mirall.spaces()`).
async function diag(label: string, type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  try {
    const data = await request(type, payload)
    console.log(`[mirall] ${label}:`, data)
    return data
  } catch (err) {
    console.error(`[mirall] ${label} failed:`, err)
    throw err
  }
}

async function verbose(on = true): Promise<boolean> {
  // Worker leg: flip its runtime-config so its logger starts/stops emitting.
  try {
    await request('setVerbose', { verbose: on })
  } catch (err) {
    console.warn('[mirall] worker verbose toggle failed:', err)
  }
  // Main leg: flip its live debug gate (and the worker-spawn seed).
  const mainDebug = await window.bridge.setVerbose(on)
  console.log(
    `[mirall] verbose logging ${on ? 'ON' : 'OFF'} — worker debug logs ` +
    `${on ? 'now stream into this console as [worker stdout] …' : 'silenced'} (main debug=${mainDebug})`,
  )
  return on
}

const mirall: MirallDevConsole = {
  help,
  verbose,
  status: () => diag('network status', 'network:status:get'),
  spaces: () => diag('spaces', 'spaces:list'),
  members: (spaceId: string) => diag('online members', 'members:online', { spaceId }),
  storage: () => diag('storage', 'storage:info'),
  audit: (opts: Record<string, unknown> = {}) => diag('audit', 'audit:list', { limit: 20, ...opts }),
  mounts: () => diag('mounts', 'mounts:list-all'),
  profile: () => diag('profile', 'profile:get'),
  features: () => diag('feature flags', 'features:get'),
  // Per-request call counts, failures, in-flight and timing. This is how the fan-out claims in the
  // architecture review get checked against a running app instead of estimated.
  metrics: async () => {
    const diagnostics = await request('diagnostics:export', { redact: true }) as {
      requests?: { metrics?: Record<string, unknown>; failures?: Record<string, unknown> }
    }
    const metrics = diagnostics.requests?.metrics ?? {}
    console.table(metrics)
    if (diagnostics.requests?.failures) console.table(diagnostics.requests.failures)
    return metrics
  },
  version: async () => {
    const v = await window.bridge.appVersion()
    console.log('[mirall] version:', v)
    return v
  },
  update: async () => {
    const v = await window.bridge.checkForUpdate()
    console.log('[mirall] update lookup:', v)
    return v
  },
  identity: async () => {
    const v = await window.bridge.getIdentityProtection()
    console.log('[mirall] identity protection:', v)
    return v
  },
}

if (typeof window !== 'undefined') {
  window.mirall = mirall
  // Mirror main-process logs into this console. Main only forwards while its
  // debug gate is on (mirall.verbose flips it), so this is quiet otherwise. The
  // [main] prefix is also what main's renderer→main mirror keys on to avoid a loop.
  window.bridge.onMainLog?.(({ level, text }) => {
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink('[main]', text)
  })
  console.log('[mirall] dev console ready — type mirall.help()')
}
