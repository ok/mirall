// The organization's locked values as the rest of the app sees them: null on every install without
// an accepted license, and then nothing anywhere behaves differently. Only ManagedConfig sets it; its
// close resets it.
import { AppError } from './errors.js'
import { CODES } from '../contract/errors.js'

let overlay = null
let orgRelayTest = null

export const getManagedOverlay = () => overlay

/** @internal ManagedConfig only */
export function setManagedOverlay(next) {
  overlay = next
}

export function resetManagedOverlay() {
  overlay = null
  orgRelayTest = null
}

export const isLocked = (key) => overlay !== null && key in overlay.settings

// The last Test of the organization's relay: kept in memory, never in the person's settings.
export const getOrgRelayTest = () => orgRelayTest
export function setOrgRelayTest(verdict) {
  orgRelayTest = verdict
}

const sameValue = (a, b) => a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && a.publicKey === b.publicKey)

const lockedError = (key, channel) => new AppError(CODES.MANAGED_LOCKED, `${channel}: ${key} is set by your organization`)

// Refuses a write that would change a value the organization has locked. Re-sending the effective
// value is allowed, so a caller that echoes the current value keeps working.
export function assertUnlocked(key, next, current, channel) {
  if (next === undefined || !isLocked(key) || sameValue(next, current)) return
  throw lockedError(key, channel)
}

// An organization that keeps recording on keeps the record: nothing may delete what it requires,
// neither a purge nor a smaller row cap. A gate locks only toward on, so locked means recording.
export const recordKept = () => overlay !== null && overlay.settings['audit.enabled'] === true

export function assertRecordKept(channel) {
  if (recordKept()) throw lockedError('audit.enabled', channel)
}
