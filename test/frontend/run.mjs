import { execFileSync } from 'node:child_process'
import { rmSync, mkdirSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestnet } from './testnet.mjs'
import { SCENARIOS, load } from './scenarios/index.mjs'
import { drainReports } from './assert.mjs'
import { WORK } from './paths.mjs'
import { agentDesktopTooOld, MIN_AGENT_DESKTOP } from './preflight.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const runDir = path.join(REPO, 'test/frontend/evidence', new Date().toISOString().replace(/[:.]/g, '-'))
const args = process.argv.slice(2)

// Fail fast on an environment that can't drive the UI, instead of letting every
// scenario stall for 90s on "Mirall window never appeared" / STALE_REF.
//
// The harness requires agent-desktop >= 0.8.0 (preflight.mjs carries the full
// ladder): 0.3.0 brought back persisted, session-scoped snapshots, so a ref taken
// in one CLI process resolves in the next (the snapshot-then-act pattern this
// suite makes), and 0.7.0 turned an over-budget snapshot into ok:true +
// complete:false, which instance.snap() reads so a truncated tree is never
// asserted against as if it were the whole window.
function preflight() {
  let version, granted
  try {
    version = JSON.parse(execFileSync('agent-desktop', ['version'], { encoding: 'utf8' })).data.version
  } catch {
    throw new Error(`agent-desktop not found on PATH. Install it: npm install -g agent-desktop@${MIN_AGENT_DESKTOP}`)
  }
  if (agentDesktopTooOld(version)) {
    throw new Error(
      `agent-desktop ${version} is too old: cross-process refs need session-scoped snapshots (>= ${MIN_AGENT_DESKTOP}).\n` +
      'Upgrade:  npm install -g agent-desktop@latest',
    )
  }
  try {
    // 0.3.0+ reports nested { accessibility: { state }, ... }; Accessibility is what the AX tree needs.
    granted = JSON.parse(execFileSync('agent-desktop', ['permissions'], { encoding: 'utf8' })).data.accessibility?.state === 'granted'
  } catch {}
  if (granted === false) {
    throw new Error(
      'agent-desktop lacks Accessibility permission. Grant it to the app that launches the\n' +
      'tests (e.g. your terminal) in System Settings > Privacy & Security > Accessibility,\n' +
      'plus Screen Recording for screenshots, then restart that app.',
    )
  }
}

// agent-desktop never prunes its per-snapshot refmap dirs under ~/.agent-desktop, and a bloated
// store taxes every snapshot. Nothing carries over between scenarios, so clear it at the start of
// each run; the CLI recreates the dirs on next use.
function pruneAgentDesktopStore() {
  const store = path.join(os.homedir(), '.agent-desktop')
  let stale = 0
  try { stale = readdirSync(path.join(store, 'snapshots')).length } catch {}
  for (const sub of ['snapshots', 'sessions']) {
    rmSync(path.join(store, sub), { recursive: true, force: true })
  }
  // The root-level "latest snapshot" pointer and refmap go too: a refmap written by an older CLI
  // makes `agent-desktop status` fail with INVALID_ARGS until it is gone, and nothing here reads
  // them (each Instance uses its own --session namespace).
  for (const f of ['last_refmap.json', 'latest_snapshot_id']) {
    rmSync(path.join(store, f), { force: true })
  }
  if (stale) console.error(`pruned ${stale} stale agent-desktop snapshot(s)`)
}

const pick = args.filter((a) => !a.startsWith('--'))
const keys = pick.length ? pick : SCENARIOS.map((s) => s.key)

// key → scenario file slug (s4 → s4-transfer) for the progress banner.
const slugByKey = Object.fromEntries(SCENARIOS.map((s) => [s.key, s.slug]))

;(async () => {
  preflight()
  pruneAgentDesktopStore()
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
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
      try {
        const out = await (await load(key))({ runDir, bootstrap: net.bootstrap })
        pass = out.pass
        instances = out.instances || []
      } catch (e) {
        crash = e.message
      }
      // Collect this scenario's per-step report(s) so the final summary can name
      // exactly which steps failed without scrolling back through the log.
      const failedSteps = drainReports()
        .flatMap((r) => r.steps.filter((s) => !s.pass).map((s) => ({ label: s.label, err: s.err })))
      results.push({ key, pass: pass && !crash, crash, failedSteps })
      // Tear down and WAIT before the next scenario launches: overlapping teardowns starve worker IPC.
      await Promise.all(instances.map((i) => i.kill()))
    }
  } finally {
    await net.destroy()
  }

  // Aggregate summary — same shape as the unit/integration TAP tally, so a failed
  // scenario (and the exact step that failed) is visible at a glance.
  console.log('\n──────── Frontend test summary ────────')
  for (const r of results) {
    console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.key}`)
    if (r.crash) console.log(`       ↳ crashed: ${r.crash}`)
    for (const s of r.failedSteps) console.log(`       ↳ ${s.label}${s.err ? ' — ' + s.err : ''}`)
  }
  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).map((r) => r.key)
  console.log(`\nscenarios = ${passed}/${results.length} passed`)
  if (failed.length) console.log(`failed: ${failed.join(', ')}`)
  console.log(`\nevidence: ${runDir}`)
  process.exit(failed.length === 0 ? 0 : 1)
})()
