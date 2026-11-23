// The app-update status main owns and the renderer shows. `idle` with a `lastCheckedAt` is a
// confirmed "up to date"; `idle` without one means no pass has reached the update network yet.
// `progress` is the download's whole percentage, null outside a download and until the download
// has been sized; it stops short of 100 because only `ready` says the update is usable.
// `available` is a newer version that waits for the user's go-ahead, because the update mode is not
// automatic; `held` says the download in flight will wait for it too.

export const UPDATE_STATE = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  AVAILABLE: 'available',
  ERROR: 'error',
  OFF: 'off',
})

export const UPDATE_STATES = Object.freeze(Object.values(UPDATE_STATE))

export const UPDATES_OFF_REASON = Object.freeze({
  DEB_INSTALL: 'deb-install',
  FLAG: 'flag',
  NO_UPGRADE_KEY: 'no-upgrade-key',
})

export const UPDATES_OFF_REASONS = Object.freeze(Object.values(UPDATES_OFF_REASON))

// How much of an update runs without the user: `automatic` downloads and installs, `notify` looks
// and tells. There is no mode that stops looking: a user can decline a version, not the knowledge
// that one exists.
export const UPDATE_MODE = Object.freeze({
  AUTOMATIC: 'automatic',
  NOTIFY: 'notify',
})

export const UPDATE_MODES = Object.freeze(Object.values(UPDATE_MODE))

/**
 * A stored mode that is not in the vocabulary reads as the default.
 * @param {unknown} value
 * @returns {UpdateMode}
 */
export function normalizeUpdateMode(value) {
  return UPDATE_MODES.find((mode) => mode === value) ?? UPDATE_MODE.AUTOMATIC
}

/**
 * @typedef {(typeof UPDATE_STATES)[number]} UpdateState
 * @typedef {(typeof UPDATES_OFF_REASONS)[number]} UpdatesOffReason
 * @typedef {(typeof UPDATE_MODES)[number]} UpdateMode
 * @typedef {{
 *   state: UpdateState,
 *   nextVersion: string | null,
 *   lastCheckedAt: number | null,
 *   offReason: UpdatesOffReason | null,
 *   canRestart: boolean,
 *   progress: number | null,
 *   waitingForPeers: boolean,
 *   mode: UpdateMode,
 *   held: boolean,
 * }} UpdateStatus
 */
