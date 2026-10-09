// The app-update status main owns and the renderer shows. `idle` with a `lastCheckedAt` is a
// confirmed "up to date"; `idle` without one means no pass has reached the update network yet.

export const UPDATE_STATE = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  DOWNLOADING: 'downloading',
  READY: 'ready',
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

/**
 * @typedef {(typeof UPDATE_STATES)[number]} UpdateState
 * @typedef {(typeof UPDATES_OFF_REASONS)[number]} UpdatesOffReason
 * @typedef {{
 *   state: UpdateState,
 *   nextVersion: string | null,
 *   lastCheckedAt: number | null,
 *   offReason: UpdatesOffReason | null,
 *   canRestart: boolean,
 * }} UpdateStatus
 */
