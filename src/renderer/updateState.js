// Pure, dependency-free state transitions for the in-app update notice. Kept as
// plain JS (no React/window) so it is the single source of truth shared by the
// renderer bundle (esbuild/tsc) and the brittle-node unit suite — same pattern
// as sharePaths.js / shared/channel.js.
//
// Two consumers read this state:
//   - the dismissable banner (TopNav) shows while `update && !dismissed`
//   - the About box shows a permanent notice while `update` is set, ignoring
//     `dismissed` — so dismissing the banner never hides the fact that an
//     update is staged.

/**
 * @typedef {{ fork: number, length: number, semver: string | null }} UpdateVersion
 * @typedef {{ app: boolean, version: UpdateVersion }} UpdateInfo
 * @typedef {{ update: UpdateInfo | null, dismissed: boolean }} UpdateState
 */

/** @type {UpdateState} */
export const initialUpdateState = { update: null, dismissed: false }

/**
 * Record a freshly-detected update. A genuinely different version (vs. the same
 * one re-announced on a later drive append) clears any prior dismissal so the
 * banner reappears; re-announcing the same version preserves the user's
 * dismissal so we don't nag on every append.
 * @param {UpdateState} prev
 * @param {UpdateVersion} version
 * @returns {UpdateState}
 */
export function reduceDetectedUpdate(prev, version) {
  const cur = prev.update && prev.update.version
  const changed = !cur || cur.semver !== version.semver || cur.length !== version.length || cur.fork !== version.fork
  return { update: { app: true, version }, dismissed: changed ? false : prev.dismissed }
}

/**
 * Mark the banner dismissed. Leaves `update` intact so the About notice stays.
 * Returns the same reference when already dismissed so callers can skip a
 * redundant re-render/emit.
 * @param {UpdateState} prev
 * @returns {UpdateState}
 */
export function reduceDismissed(prev) {
  if (prev.dismissed) return prev
  return { update: prev.update, dismissed: true }
}
