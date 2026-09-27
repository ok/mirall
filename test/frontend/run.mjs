import { execFileSync } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { startTestnet } from './testnet.mjs'
import { SCENARIOS, load } from './scenarios/index.mjs'
import { drainReports } from './assert.mjs'
import { WORK } from './paths.mjs'
import { agentDesktopTooOld, MIN_AGENT_DESKTOP } from './preflight.mjs'
import { focusedMirallWindows } from './ax-support.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const runDir = path.join(REPO, 'test/frontend/evidence', new Date().toISOString().replace(/[:.]/g, '-'))
const args = process.argv.slice(2)
if (args.includes('--foreground')) process.env.FE_MODE = 'foreground'
const foreground = process.env.FE_MODE === 'foreground'

// Fail fast on an environment that can't drive the UI, instead of letting every
// scenario stall for 90s on "Mirall window never appeared" / STALE_REF.
//
// The floor and why it sits where it does live in preflight.mjs.
function preflight() {
  let version, perms
  try {
    version = JSON.parse(execFileSync('agent-desktop', ['version'], { encoding: 'utf8' })).data.version
  } catch {
    throw new Error(`agent-desktop not found on PATH. Install it: npm install -g agent-desktop@${MIN_AGENT_DESKTOP}`)
  }
  if (agentDesktopTooOld(version)) {
    throw new Error(
      `agent-desktop ${version} is too old for this harness (>= ${MIN_AGENT_DESKTOP}).\n` +
      'Upgrade:  npm install -g agent-desktop@latest',
    )
  }
  try {
    perms = JSON.parse(execFileSync('agent-desktop', ['permissions'], { encoding: 'utf8' })).data
  } catch {}
  if (perms && perms.accessibility?.state !== 'granted') {
    throw new Error(
      'agent-desktop lacks Accessibility permission. Grant it to the app that launches the\n' +
      'tests (e.g. your terminal) in System Settings > Privacy & Security > Accessibility,\n' +
      'plus Screen Recording for screenshots, then restart that app.',
    )
  }
  if (perms && perms.screen_recording?.state !== 'granted') {
    console.error('warning: no Screen Recording permission — evidence screenshots will fail')
  }
}

// agent-desktop keeps sessions, per-snapshot refmaps and locks under one state root and never prunes
// it; a bloated store taxes every snapshot. Give each run a fresh root inside the work dir, which is
// wiped at the start of the next run, so nothing leaks between runs or into ~/.agent-desktop.
function isolateAgentDesktopState() {
  const home = path.join(WORK, 'agent-desktop')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  process.env.AGENT_DESKTOP_HOME = home
}

const pick = args.filter((a) => !a.startsWith('--'))
const keys = pick.length ? pick : SCENARIOS.map((s) => s.key)

// key → scenario file slug (s4 → s4-transfer) for the progress banner.
const slugByKey = Object.fromEntries(SCENARIOS.map((s) => [s.key, s.slug]))

;(async () => {
  preflight()
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  isolateAgentDesktopState()
  console.log(`mode: ${foreground ? 'foreground (raises windows, real keystrokes)' : 'background (the desktop stays yours)'}`)
  if (!args.includes('--no-build')) execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' })
  const net = await startTestnet()
  const results = []
  try {
    for (const [idx, key] of keys.entries()) {
      // Attribute live log output (launch lines, step failures) to a numbered scenario.
      console.log(`\n──── ${slugByKey[key] ?? key} (${idx + 1}/${keys.length}) ────`)
      let instances = []
      let pass = false
      let crash = null
      const started = Date.now()
      try {
        const out = await (await load(key))({ runDir, bootstrap: net.bootstrap })
        pass = out.pass
        instances = out.instances || []
      } catch (e) {
        crash = e.message
      }
      // The background-mode promise: the harness never makes a Mirall window the focused one. Checked
      // before teardown, while the windows still exist.
      if (!foreground) {
        const stolen = await focusedMirallWindows().catch(() => [])
        if (stolen.length) crash = `${crash ? crash + '; ' : ''}harness left a Mirall window focused (${stolen.join(', ')})`
      }
      const secs = Math.round((Date.now() - started) / 100) / 10
      // Collect this scenario's per-step report(s) so the final summary can name
      // exactly which steps failed without scrolling back through the log.
      const failedSteps = drainReports()
        .flatMap((r) => r.steps.filter((s) => !s.pass).map((s) => ({ label: s.label, err: s.err })))
      results.push({ key, pass: pass && !crash, crash, failedSteps, secs })
      // Tear down and WAIT before the next scenario launches: overlapping teardowns starve worker IPC.
      await Promise.all(instances.map((i) => i.kill({ hard: true })))
    }
  } finally {
    await net.destroy()
  }

  // Aggregate summary — same shape as the unit/integration TAP tally, so a failed
  // scenario (and the exact step that failed) is visible at a glance.
  console.log('\n──────── Frontend test summary ────────')
  for (const r of results) {
    console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.key.padEnd(6)} ${String(r.secs).padStart(6)}s`)
    if (r.crash) console.log(`       ↳ crashed: ${r.crash}`)
    for (const s of r.failedSteps) console.log(`       ↳ ${s.label}${s.err ? ' — ' + s.err : ''}`)
  }
  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).map((r) => r.key)
  const total = Math.round(results.reduce((sum, r) => sum + r.secs, 0))
  console.log(`\nscenarios = ${passed}/${results.length} passed in ${Math.floor(total / 60)}m${total % 60}s`)
  if (failed.length) console.log(`failed: ${failed.join(', ')}`)
  console.log(`\nevidence: ${runDir}`)
  process.exit(failed.length === 0 ? 0 : 1)
})()
