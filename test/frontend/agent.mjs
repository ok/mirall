import { execFile } from 'node:child_process'

const BIN = 'agent-desktop'
// Retryable: the retry re-snapshots and re-resolves the ref, so a settled element is hit next pass.
//   STALE_REF, WINDOW_NOT_FOUND  transient AX state
//   ACTION_FAILED                every click strategy missed — the element moved between snapshot and click
//   ELEMENT_NOT_FOUND            the snapshot ran a frame before a menu/modal element rendered
//   ACTION_NOT_SUPPORTED         window listed and painted but its AX tree not attached yet (Chromium attaches lazily)
//   SNAPSHOT_INCOMPLETE          ours: instance.snap() maps ok:true + complete:false to it, so a truncated tree
//                                is never asserted against
export const RETRYABLE = new Set(['STALE_REF', 'WINDOW_NOT_FOUND', 'ACTION_FAILED', 'ELEMENT_NOT_FOUND', 'SNAPSHOT_INCOMPLETE', 'ACTION_NOT_SUPPORTED'])

// The activation chain (AXPress → AXOpen → physical fallback) gives up after this; at the default
// 10 s an element that cannot settle stalls the full deadline before ACTION_FAILED, times 3 retries.
// The harness settles animations itself and re-snapshots on failure, so fail fast into the retry.
const CHAIN_TIMEOUT_MS = process.env.AGENT_DESKTOP_CHAIN_TIMEOUT_MS ?? '2500'

// Ref actions also auto-wait for resolution/actionability (--timeout-ms, default 5000) BEFORE the
// chain above; at the default the two budgets stack across every retry. The retry re-resolves the
// ref, so a long in-process wait only delays the fix. Only these subcommands accept the flag.
const AUTO_WAIT_CMDS = new Set(['click', 'type', 'focus', 'set-value', 'scroll', 'hover', 'toggle', 'select'])
export const ACTION_TIMEOUT_MS = process.env.AGENT_DESKTOP_ACTION_TIMEOUT_MS ?? '1500'

// agent-desktop 0.3.0+ takes --session / --headed as GLOBAL options that must
// precede the subcommand. --session namespaces the persisted "latest snapshot"
// so a ref resolves the same across the separate snapshot/act CLI processes this
// harness makes; --headed lets cursor commands (hover, mouse-move) run instead of
// returning POLICY_DENIED in the default headless mode. Hoist them here.
export function agentArgs(args, { session = null, headed = false } = {}) {
  const globals = []
  if (session) globals.push('--session', session)
  if (headed) globals.push('--headed')
  const tuned = AUTO_WAIT_CMDS.has(args[0]) && !args.includes('--timeout-ms')
    ? [...args, '--timeout-ms', ACTION_TIMEOUT_MS]
    : args
  return [...globals, ...tuned]
}

// 0.8.x builds a global window inventory (CoreGraphics + AX) before resolving a
// target, and fails the WHOLE command with TIMEOUT when that inventory will not hold
// still. Four wordings observed: "CoreGraphics window inventory did not stabilize",
// "CoreGraphics window inventory timed out", "Global application window inventory did
// not stabilize", and "NSWorkspace app inventory timed out" — hence matching on the
// shared "inventory …" shape rather than any one string. They fire while a sibling
// Electron instance is mid-launch — precisely when windows are churning — and it
// says nothing about the app under test. Absorb it here, with a backoff long enough
// for the launch to settle, instead of letting tool noise fail a scenario.
const INVENTORY_UNSTABLE = /inventory (did not stabilize|timed out)/i
const INVENTORY_TRIES = 4

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function ad(args, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const mayRetry = attempt < INVENTORY_TRIES - 1
    try {
      const parsed = await adOnce(args, opts)
      // With allowError the failure comes back as a value rather than a throw.
      if (mayRetry && parsed?.ok === false && INVENTORY_UNSTABLE.test(parsed.error?.message ?? '')) {
        await sleep(300 * (attempt + 1))
        continue
      }
      return parsed
    } catch (e) {
      if (mayRetry && INVENTORY_UNSTABLE.test(e.raw?.error?.message ?? '')) {
        await sleep(300 * (attempt + 1))
        continue
      }
      throw e
    }
  }
}

function adOnce(args, { allowError = false, session = null, headed = false } = {}) {
  const argv = agentArgs(args, { session, headed })
  return new Promise((resolve, reject) => {
    const env = { ...process.env, AGENT_DESKTOP_CHAIN_TIMEOUT_MS: CHAIN_TIMEOUT_MS }
    execFile(BIN, argv, { maxBuffer: 32 * 1024 * 1024, env }, (_err, stdout) => {
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(new Error(`agent-desktop non-JSON for [${argv.join(' ')}]: ${String(stdout).slice(0, 200)}`))
      }
      if (!parsed.ok && !allowError) {
        const e = parsed.error ?? {}
        return reject(Object.assign(new Error(`agent-desktop ${args[0]} -> ${e.code}: ${e.message}`), { code: e.code, raw: parsed }))
      }
      resolve(parsed)
    })
  })
}

export async function withRetry(fn, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!RETRYABLE.has(e.code)) throw e
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  throw last
}
