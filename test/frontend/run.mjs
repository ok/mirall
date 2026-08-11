import { execFileSync } from 'node:child_process'
import { rmSync, mkdirSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestnet } from './testnet.mjs'
import { drainReports } from './assert.mjs'
import { WORK } from './paths.mjs'
import { agentDesktopTooOld, MIN_AGENT_DESKTOP } from './preflight.mjs'
import s1 from './scenarios/s1-shell.mjs'
import s2 from './scenarios/s2-connect.mjs'
import s3 from './scenarios/s3-join-errors.mjs'
import s4 from './scenarios/s4-transfer.mjs'
import s5 from './scenarios/s5-owned-folder.mjs'
import s6 from './scenarios/s6-mirror.mjs'
import s8 from './scenarios/s8-settings.mjs'
import s9 from './scenarios/s9-folder-lifecycle.mjs'
import s10 from './scenarios/s10-file-actions.mjs'
import s11 from './scenarios/s11-remove-file.mjs'
import s12 from './scenarios/s12-add-folder-validation.mjs'
import s13 from './scenarios/s13-edit-space.mjs'
import s14 from './scenarios/s14-account.mjs'
import s15 from './scenarios/s15-appearance.mjs'
import s16 from './scenarios/s16-general-notifications.mjs'
import s17 from './scenarios/s17-network-status.mjs'
import s18 from './scenarios/s18-about.mjs'
import s19 from './scenarios/s19-invite-single-link.mjs'
import s20 from './scenarios/s20-command-palette.mjs'
import s21 from './scenarios/s21-empty-states.mjs'
import s22 from './scenarios/s22-onboarding-validation.mjs'
import s23 from './scenarios/s23-relocate.mjs'
import s24 from './scenarios/s24-unmount-in-folder.mjs'
import s25 from './scenarios/s25-mirror-paused-in-folder.mjs'
import s26 from './scenarios/s26-add-file-to-folder.mjs'
import s27 from './scenarios/s27-delete-file-in-folder.mjs'
import s28 from './scenarios/s28-subfolder.mjs'
import s29 from './scenarios/s29-move-into-subfolder.mjs'
import s30 from './scenarios/s30-delete-file-in-subfolder.mjs'
import s31 from './scenarios/s31-edit-and-readonly-revert.mjs'
import s32 from './scenarios/s32-mirror-keeps-unrelated-file.mjs'
import s33 from './scenarios/s33-copy-file.mjs'
import s34 from './scenarios/s34-nested-initial-share.mjs'
import s35 from './scenarios/s35-live-folder-refresh.mjs'
import s36 from './scenarios/s36-browse-download-subfolder.mjs'
import s37 from './scenarios/s37-large-file.mjs'
import s38 from './scenarios/s38-multiple-folders.mjs'
import s39 from './scenarios/s39-ignored-junk.mjs'
import s40 from './scenarios/s40-empty-subfolder.mjs'
import s41 from './scenarios/s41-owner-offline.mjs'
import s42 from './scenarios/s42-mirror-file-progress.mjs'
import s48 from './scenarios/s48-folder-download-pause.mjs'
import s49 from './scenarios/s49-folder-download-cancel.mjs'
import s50 from './scenarios/s50-mirror-no-file-controls.mjs'
import s51 from './scenarios/s51-members-foldout.mjs'
import s52 from './scenarios/s52-storage-other.mjs'
import s53 from './scenarios/s53-leftover-cleanup.mjs'
import s54 from './scenarios/s54-membership-approve-single.mjs'
import s55 from './scenarios/s55-membership-approve-batch.mjs'
import s56 from './scenarios/s56-membership-deny-and-invite-toggle.mjs'
import s57 from './scenarios/s57-membership-deny-in-modal.mjs'
import s58 from './scenarios/s58-membership-convergence.mjs'
import s59 from './scenarios/s59-membership-cancel.mjs'
import s60 from './scenarios/s60-membership-waiting-pill.mjs'
import s61 from './scenarios/s61-member-identity-sync.mjs'
import s62 from './scenarios/s62-create-space-no-invite-code.mjs'
import s63 from './scenarios/s63-pending-request-offline-convergence.mjs'
import s64 from './scenarios/s64-join-link-paste.mjs'
import s65 from './scenarios/s65-owner-convergence.mjs'
import s66 from './scenarios/s66-overlay-folder.mjs'
import s67 from './scenarios/s67-overlay-toggle-hidden.mjs'
import s68 from './scenarios/s68-overlay-verified-check.mjs'
import s69 from './scenarios/s69-loose-file-verified-row.mjs'
import s70 from './scenarios/s70-folder-card-hit-area.mjs'
import s71 from './scenarios/s71-loose-source-change-restart.mjs'
import s73 from './scenarios/s73-peer-download-indicator.mjs'
import s74 from './scenarios/s74-peer-download-multi.mjs'
import s75 from './scenarios/s75-folder-peer-download-indicator.mjs'
import s76 from './scenarios/s76-invite-create-flow.mjs'
import s77 from './scenarios/s77-folder-listing-no-flicker.mjs'
import s78 from './scenarios/s78-folder-truncated-listing.mjs'
import s104 from './scenarios/s104-add-folder-over-limit.mjs'
import s105 from './scenarios/s105-network-limits.mjs'
import s106 from './scenarios/s106-network-relays.mjs'
import s107 from './scenarios/s107-space-download-folder.mjs'
import s79 from './scenarios/s79-folder-source-missing.mjs'
import s80 from './scenarios/s80-space-switch-roster.mjs'
import s81 from './scenarios/s81-space-card-facepile.mjs'
import s82 from './scenarios/s82-loose-download-pause.mjs'
import s83 from './scenarios/s83-loose-download-cancel.mjs'
import s84 from './scenarios/s84-loose-download-discard-partial.mjs'
import s85 from './scenarios/s85-cancel-publish-indexing.mjs'
import s86 from './scenarios/s86-loose-preparing-status.mjs'
import s87 from './scenarios/s87-owner-crash-mid-index.mjs'
import s88 from './scenarios/s88-unshare-mid-download.mjs'
import s89 from './scenarios/s89-delete-share-mid-download.mjs'
import s90 from './scenarios/s90-delete-file-mid-download.mjs'
import s91 from './scenarios/s91-unshare-after-download.mjs'
import s92 from './scenarios/s92-owner-offline-mid-download.mjs'
import s93 from './scenarios/s93-owner-return-resume.mjs'
import s94 from './scenarios/s94-manual-pause-survives-owner-return.mjs'
import s95 from './scenarios/s95-sender-sees-peer-paused.mjs'
import s96 from './scenarios/s96-two-peers-one-cancels.mjs'
import s97 from './scenarios/s97-two-peers-owner-unshares.mjs'
import s98 from './scenarios/s98-owner-leaves-mid-serve.mjs'
import s99 from './scenarios/s99-downloader-leaves-mid-download.mjs'
import s100 from './scenarios/s100-reshare-after-unshare.mjs'
import s101 from './scenarios/s101-cancel-then-redownload.mjs'
import s102 from './scenarios/s102-remove-readd-no-autoresume.mjs'
import s103 from './scenarios/s103-folder-tree.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const runDir = path.join(REPO, 'test/frontend/evidence', new Date().toISOString().replace(/[:.]/g, '-'))
const args = process.argv.slice(2)

// Fail fast on an environment that can't drive the UI, instead of letting every
// scenario stall for 90s on "Mirall window never appeared" / STALE_REF.
//
// The harness requires agent-desktop >= 0.3.0 (see preflight.mjs): 0.3.0
// reintroduced persisted, session-scoped snapshots, so a ref taken in one CLI
// process resolves in the next (the snapshot-then-act pattern this suite makes).
// Older 0.2.x re-resolved refs per-command and returned STALE_REF cross-process.
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

// agent-desktop persists a refmap dir per snapshot under ~/.agent-desktop and
// never prunes them, so the store grows unbounded across runs (hundreds of dirs
// pile up — and a bloated store slowly taxes every snapshot's directory ops).
// Each scenario writes its own fresh snapshots, so nothing carries over: clear
// the store at the start of every run. The CLI recreates the dirs on next use.
function pruneAgentDesktopStore() {
  const store = path.join(os.homedir(), '.agent-desktop')
  let stale = 0
  try { stale = readdirSync(path.join(store, 'snapshots')).length } catch {}
  for (const sub of ['snapshots', 'sessions']) {
    rmSync(path.join(store, sub), { recursive: true, force: true })
  }
  if (stale) console.error(`pruned ${stale} stale agent-desktop snapshot(s)`)
}

const ALL = { s1, s2, s3, s4, s5, s6, s8, s9, s10, s11, s12, s13, s14, s15, s16, s17, s18, s19, s20, s21, s22, s23, s24, s25, s26, s27, s28, s29, s30, s31, s32, s33, s34, s35, s36, s37, s38, s39, s40, s41, s42, s48, s49, s50, s51, s52, s53, s54, s55, s56, s57, s58, s59, s60, s61, s62, s63, s64, s65, s66, s67, s68, s69, s70, s71, s73, s74, s75, s76, s77, s78, s79, s80, s81, s82, s83, s84, s85, s86, s87, s88, s89, s90, s91, s92, s93, s94, s95, s96, s97, s98, s99, s100, s101, s102, s103, s104, s105, s106, s107 }
const pick = args.filter((a) => !a.startsWith('--'))
const keys = pick.length ? pick : Object.keys(ALL)

// key → scenario file slug (s4 → s4-transfer) for the progress banner.
const slugByKey = Object.fromEntries(
  readdirSync(path.join(import.meta.dirname, 'scenarios'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => [f.split('-')[0], f.replace(/\.mjs$/, '')]),
)

;(async () => {
  preflight()
  pruneAgentDesktopStore()
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  if (!args.includes('--no-build')) execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' })
  const net = await startTestnet()
  const results = []
  const live = []
  try {
    for (const [idx, key] of keys.entries()) {
      // Attribute live log output (launch lines, step failures) to a numbered scenario.
      console.log(`\n──── ${slugByKey[key] ?? key} (${idx + 1}/${keys.length}) ────`)
      let instances = []
      let pass = false
      let crash = null
      try {
        const out = await ALL[key]({ runDir, bootstrap: net.bootstrap })
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
      // Fully tear down this scenario's instances — and wait for them to exit —
      // before the next one launches. Without the await, the next scenario's
      // two Electron apps came up while these were still shutting down, and the
      // overlap accumulated over a long run until worker IPC timed out.
      await Promise.all(instances.map((i) => i.kill()))
    }
  } finally {
    await Promise.all(live.map((i) => i.kill()))
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
