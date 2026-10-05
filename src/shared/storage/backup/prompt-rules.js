// When the app asks about the backup, and when it stays quiet. Before a backup is set up it offers one,
// to people with something to protect (a space, or a device with no system keychain), backing off after
// each "Not now" and stopping after the third. Once set up it asks now and then whether the passphrase
// is still known — that is the part people lose — and it calls a backup stale when none has succeeded
// for ten days. Pure: the worker keeps the state (backup-state.js) and passes the clock in.

export const DAY_MS = 24 * 60 * 60 * 1000
export const STALE_AFTER_MS = 10 * DAY_MS
export const OFFER_SNOOZE_MS = Object.freeze([30 * DAY_MS, 60 * DAY_MS])
export const OFFER_MAX_DISMISSALS = 3
export const CHECK_FIRST_MS = 14 * DAY_MS
export const CHECK_EVERY_MS = 182 * DAY_MS
export const CHECK_SNOOZE_MS = 7 * DAY_MS

export const PROMPT = Object.freeze({ OFFER: 'offer', CHECK: 'check' })
export const VERDICT = Object.freeze({ PROTECTED: 'protected', AT_RISK: 'at-risk', STOPPED: 'stopped' })
// Why the verdict is what it is, so every screen says the same thing for the same cause.
export const VERDICT_REASON = Object.freeze({
  NOT_SET_UP: 'not-set-up',
  FAILING: 'failing',
  FIRST_BACKUP: 'first-backup',
  KEY_NOT_IN_FOLDER: 'key-not-in-folder',
  UNCONFIRMED: 'unconfirmed',
  STALE: 'stale',
  NO_KEY: 'no-key',
})

export function freshState() {
  return {
    setupAt: null,
    lastSuccessAt: null,
    keyContent: null,
    keyCreatedAt: null,
    keyInFolder: false,
    keyCheckedAt: null,
    secondCopyAt: null,
    offer: { dismissals: 0, nextAt: 0 },
    check: { nextAt: null, snoozed: false, optOut: false },
  }
}

export function backupPrompt({ now, setUp, eligible, state }) {
  if (!setUp) {
    const due = eligible && state.offer.dismissals < OFFER_MAX_DISMISSALS && now >= state.offer.nextAt
    return due ? PROMPT.OFFER : null
  }
  const { check } = state
  const due = state.keyCreatedAt !== null && !check.optOut && check.nextAt !== null && now >= check.nextAt
  return due ? PROMPT.CHECK : null
}

export function snoozed(state, prompt, now) {
  if (prompt === PROMPT.OFFER) {
    const dismissals = state.offer.dismissals + 1
    const wait = OFFER_SNOOZE_MS[Math.min(dismissals, OFFER_SNOOZE_MS.length) - 1]
    return { ...state, offer: { dismissals, nextAt: now + wait } }
  }
  // One week's grace once per cycle; a second "Not now" waits for the next regular check.
  const check = state.check.snoozed
    ? { ...state.check, nextAt: now + CHECK_EVERY_MS, snoozed: false }
    : { ...state.check, nextAt: now + CHECK_SNOOZE_MS, snoozed: true }
  return { ...state, check }
}

export function optedOut(state) {
  return { ...state, check: { ...state.check, optOut: true } }
}

// Turned back on after a check fell due while off, the next one waits as for a new key rather than
// asking at once.
export function remindersSet(state, on, now) {
  const due = state.check.nextAt
  const nextAt = on && key(state) && (due === null || due < now) ? now + CHECK_FIRST_MS : due
  return { ...state, check: { ...state.check, optOut: !on, nextAt } }
}

const key = (state) => state.keyCreatedAt !== null

// Stopped when protection has lapsed: no success for ten days, or no key kept. At risk while there is
// no backup yet, the last run failed, the key is not in the folder, or its passphrase was never
// confirmed here. A missing copy of the key never changes the verdict: it is advice, not a lapse.
export function protectionVerdict({ setUp, stale, failing, state }) {
  const at = (verdict, reason) => ({ verdict, reason })
  if (!setUp) return at(VERDICT.AT_RISK, VERDICT_REASON.NOT_SET_UP)
  if (!key(state)) return at(VERDICT.STOPPED, VERDICT_REASON.NO_KEY)
  if (stale) return at(VERDICT.STOPPED, VERDICT_REASON.STALE)
  if (failing) return at(VERDICT.AT_RISK, VERDICT_REASON.FAILING)
  if (state.lastSuccessAt === null) return at(VERDICT.AT_RISK, VERDICT_REASON.FIRST_BACKUP)
  if (!state.keyInFolder) return at(VERDICT.AT_RISK, VERDICT_REASON.KEY_NOT_IN_FOLDER)
  if (state.keyCheckedAt === null) return at(VERDICT.AT_RISK, VERDICT_REASON.UNCONFIRMED)
  return at(VERDICT.PROTECTED, null)
}

// Turning the backup off is a decision, not a postponement: it is not offered again.
export function turnedOff(state) {
  return { ...state, setupAt: null, offer: { dismissals: OFFER_MAX_DISMISSALS, nextAt: 0 } }
}

// A folder chosen (at setup, or changed later): the time a first backup there is counted from.
export function folderChosen(state, now) {
  return { ...state, setupAt: now }
}

// A key this device holds no record of — another identity's, left by an identity change — is dropped.
export function keyForgotten(state) {
  return { ...state, keyContent: null, keyCreatedAt: null, keyInFolder: false, keyCheckedAt: null, secondCopyAt: null, check: { nextAt: null, snoozed: false, optOut: state.check.optOut } }
}

// A key found in the folder (a restored device, or a newer one of this identity): never confirmed here,
// so its first check is scheduled as for a new key.
export function keyAdopted(state, now, { content, createdAt }) {
  return {
    ...state,
    keyContent: content,
    keyCreatedAt: createdAt,
    keyInFolder: true,
    keyCheckedAt: null,
    secondCopyAt: null,
    check: { ...state.check, nextAt: now + CHECK_FIRST_MS, snoozed: false },
  }
}

// A new key: copies kept elsewhere open with the old passphrase, so none counts as a second copy.
export function keyWritten(state, now, { content, createdAt }) {
  return {
    ...state,
    keyContent: content,
    keyCreatedAt: createdAt,
    keyInFolder: true,
    keyCheckedAt: now,
    secondCopyAt: null,
    check: { ...state.check, nextAt: now + CHECK_FIRST_MS, snoozed: false },
  }
}

export function keyChecked(state, now) {
  return { ...state, keyCheckedAt: now, check: { ...state.check, nextAt: now + CHECK_EVERY_MS, snoozed: false } }
}

// Counted from the later of the last success and the folder being chosen, so a fresh setup is never
// stale on an older folder's last success.
export function isStale({ now, setUp, lastSuccessAt, setupAt }) {
  if (!setUp) return false
  const since = Math.max(lastSuccessAt ?? 0, setupAt ?? 0)
  return since > 0 && now - since > STALE_AFTER_MS
}
