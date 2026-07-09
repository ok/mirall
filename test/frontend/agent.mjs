import { execFile } from 'node:child_process'

const BIN = 'agent-desktop'
// STALE_REF / WINDOW_NOT_FOUND are transient AX conditions. ACTION_FAILED ("All
// chain steps exhausted") is agent-desktop reporting that every click strategy
// missed — almost always because the element moved or animated (e.g. a react-aria
// menu sliding in) between the snapshot that resolved its ref and the click. The
// retry re-snapshots and re-resolves the ref, so a settled element is hit on the
// next pass; a genuinely unclickable element still fails after the tries run out.
// ELEMENT_NOT_FOUND is retryable too: a click/type right after opening a menu or
// advancing a modal can snapshot a frame before the new element has rendered. The
// retry re-snapshots, so a just-appearing element is caught on the next pass —
// which lets the menu/modal helpers settle with a short fixed wait instead of a
// long conservative one. A genuinely-absent element still fails after the tries.
const RETRYABLE = new Set(['STALE_REF', 'WINDOW_NOT_FOUND', 'ACTION_FAILED', 'ELEMENT_NOT_FOUND'])

// agent-desktop's activation chain (the AXPress → AXOpen → physical-fallback
// ladder a ref action walks) gives up after AGENT_DESKTOP_CHAIN_TIMEOUT_MS,
// default 10_000. When an action targets an element that can't settle (an
// animating popover, a press with no observable AX state change) it stalls for
// that full deadline before returning ACTION_FAILED — and withRetry then re-tries
// up to 3× (≈30s). This harness already settles animations with its own waits and
// re-snapshots on ACTION_FAILED, so it never needs the long default: cap it low so
// an unsettled action fails fast into the retry instead of stalling. Overridable.
const CHAIN_TIMEOUT_MS = process.env.AGENT_DESKTOP_CHAIN_TIMEOUT_MS ?? '2500'

// agent-desktop 0.3.0+ takes --session / --headed as GLOBAL options that must
// precede the subcommand. --session namespaces the persisted "latest snapshot"
// so a ref resolves the same across the separate snapshot/act CLI processes this
// harness makes; --headed lets cursor commands (hover, mouse-move) run instead of
// returning POLICY_DENIED in the default headless mode. Hoist them here.
export function agentArgs(args, { session = null, headed = false } = {}) {
  const globals = []
  if (session) globals.push('--session', session)
  if (headed) globals.push('--headed')
  return [...globals, ...args]
}

export function ad(args, { allowError = false, session = null, headed = false } = {}) {
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
