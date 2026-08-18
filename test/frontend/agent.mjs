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
// ACTION_NOT_SUPPORTED covers "window exists but is not exposed through
// accessibility": Chromium attaches a renderer's AX tree lazily, so a window can be
// listed and painted a beat before it answers AX queries. agent-desktop 0.4.x
// returned an empty tree in that gap and the scenarios' own waits rode it out;
// 0.8.x makes it an error. Instance.launch() closes the gap explicitly, and this
// entry covers the mid-scenario case (a repaint or reload re-attaching AX).
// SNAPSHOT_INCOMPLETE is ours, not agent-desktop's: 0.7.0 stopped returning a
// TIMEOUT error for a snapshot that exhausts its walk budget and now returns
// ok:true with data.complete=false. instance.snap() turns that into this code so a
// partial tree retries (and ultimately fails loudly) instead of being asserted
// against as if it were the whole window.
const RETRYABLE = new Set(['STALE_REF', 'WINDOW_NOT_FOUND', 'ACTION_FAILED', 'ELEMENT_NOT_FOUND', 'SNAPSHOT_INCOMPLETE', 'ACTION_NOT_SUPPORTED'])

// agent-desktop's activation chain (the AXPress → AXOpen → physical-fallback
// ladder a ref action walks) gives up after AGENT_DESKTOP_CHAIN_TIMEOUT_MS,
// default 10_000. When an action targets an element that can't settle (an
// animating popover, a press with no observable AX state change) it stalls for
// that full deadline before returning ACTION_FAILED — and withRetry then re-tries
// up to 3× (≈30s). This harness already settles animations with its own waits and
// re-snapshots on ACTION_FAILED, so it never needs the long default: cap it low so
// an unsettled action fails fast into the retry instead of stalling. Overridable.
const CHAIN_TIMEOUT_MS = process.env.AGENT_DESKTOP_CHAIN_TIMEOUT_MS ?? '2500'

// agent-desktop 0.5.0+ also auto-waits for ref resolution and transient
// actionability on every ref action (--timeout-ms, default 5000) — a SEPARATE
// budget that runs BEFORE the chain above. Left at the default it stacks: a
// genuinely-absent element burns 5s here, then the chain, then withRetry does it
// all twice more. This harness re-snapshots and re-resolves the ref on every
// retry, so waiting long inside one CLI process only delays the re-resolution
// that would have fixed it. Cap it low and let the retry do the settling.
// Only these subcommands accept the flag (verified against 0.8.1 --help).
const AUTO_WAIT_CMDS = new Set(['click', 'type', 'focus', 'set-value', 'scroll', 'hover', 'toggle', 'select'])
const ACTION_TIMEOUT_MS = process.env.AGENT_DESKTOP_ACTION_TIMEOUT_MS ?? '1500'

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
// still. Seen in three wordings so far: "CoreGraphics window inventory did not
// stabilize", "Global application window inventory did not stabilize", and
// "NSWorkspace app inventory timed out". In this suite they fire while a sibling
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
