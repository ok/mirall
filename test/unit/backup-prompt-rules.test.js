import test from 'brittle'
import {
  backupPrompt, protectionVerdict, remindersSet, VERDICT, VERDICT_REASON, snoozed, optedOut, turnedOff, folderChosen, keyWritten, keyChecked, keyAdopted, keyForgotten, isStale, freshState,
  PROMPT, DAY_MS, OFFER_MAX_DISMISSALS, CHECK_FIRST_MS, CHECK_EVERY_MS, CHECK_SNOOZE_MS, STALE_AFTER_MS,
} from '../../src/shared/storage/backup/prompt-rules.js'

const T0 = Date.UTC(2026, 9, 1)
const KEY = { content: '{}', createdAt: '2026-10-01T00:00:00.000Z' }

test('the offer goes to people with something to protect, and backs off', (t) => {
  let state = freshState()
  t.is(backupPrompt({ now: T0, setUp: false, eligible: false, state }), null, 'no space, keychain present: nothing yet')
  t.is(backupPrompt({ now: T0, setUp: false, eligible: true, state }), PROMPT.OFFER)
  state = snoozed(state, PROMPT.OFFER, T0)
  t.is(backupPrompt({ now: T0 + 29 * DAY_MS, setUp: false, eligible: true, state }), null, 'first "Not now" holds 30 days')
  t.is(backupPrompt({ now: T0 + 30 * DAY_MS, setUp: false, eligible: true, state }), PROMPT.OFFER)
  state = snoozed(state, PROMPT.OFFER, T0 + 30 * DAY_MS)
  t.is(backupPrompt({ now: T0 + 89 * DAY_MS, setUp: false, eligible: true, state }), null, 'second holds 60 days')
  t.is(backupPrompt({ now: T0 + 90 * DAY_MS, setUp: false, eligible: true, state }), PROMPT.OFFER)
  state = snoozed(state, PROMPT.OFFER, T0 + 90 * DAY_MS)
  t.is(state.offer.dismissals, OFFER_MAX_DISMISSALS)
  t.is(backupPrompt({ now: T0 + 1000 * DAY_MS, setUp: false, eligible: true, state }), null, 'the third ends it')
})

test('turning the backup off is not met with the offer again', (t) => {
  const state = turnedOff(folderChosen(freshState(), T0))
  t.is(state.setupAt, null)
  t.is(backupPrompt({ now: T0 + 400 * DAY_MS, setUp: false, eligible: true, state }), null)
})

test('the passphrase check comes 14 days after the key, then twice a year', (t) => {
  let state = keyWritten(folderChosen(freshState(), T0), T0, KEY)
  const at = (days) => backupPrompt({ now: T0 + days * DAY_MS, setUp: true, eligible: true, state })
  t.is(at(13), null)
  t.is(at(14), PROMPT.CHECK)
  state = keyChecked(state, T0 + 14 * DAY_MS)
  t.is(state.check.nextAt, T0 + 14 * DAY_MS + CHECK_EVERY_MS)
  t.is(state.keyCheckedAt, T0 + 14 * DAY_MS)
  t.is(at(14 + 181), null)
  t.is(at(14 + 182), PROMPT.CHECK)
})

test('a check can be put off once a week, then waits for the next cycle', (t) => {
  let state = keyWritten(folderChosen(freshState(), T0), T0, KEY)
  const due = T0 + CHECK_FIRST_MS
  state = snoozed(state, PROMPT.CHECK, due)
  t.is(state.check.nextAt, due + CHECK_SNOOZE_MS)
  state = snoozed(state, PROMPT.CHECK, due + CHECK_SNOOZE_MS)
  t.is(state.check.nextAt, due + CHECK_SNOOZE_MS + CHECK_EVERY_MS, 'no second week')
  t.absent(state.check.snoozed)
})

test('opting out of the check, or having no key, silences it', (t) => {
  const keyed = keyWritten(folderChosen(freshState(), T0), T0, KEY)
  t.is(backupPrompt({ now: T0 + 400 * DAY_MS, setUp: true, eligible: true, state: optedOut(keyed) }), null)
  const keyless = { ...folderChosen(freshState(), T0), check: { nextAt: T0, snoozed: false, optOut: false } }
  t.is(backupPrompt({ now: T0 + 400 * DAY_MS, setUp: true, eligible: true, state: keyless }), null)
})

test('a new key drops the second copy and starts the check over', (t) => {
  const before = { ...keyChecked(keyWritten(freshState(), T0, { content: 'a', createdAt: 'a' }), T0 + DAY_MS), secondCopyAt: T0 + DAY_MS }
  const after = keyWritten(before, T0 + 50 * DAY_MS, { content: 'b', createdAt: 'b' })
  t.is(after.secondCopyAt, null)
  t.is(after.keyCreatedAt, 'b')
  t.is(after.keyContent, 'b')
  t.ok(after.keyInFolder)
  t.is(after.check.nextAt, T0 + 50 * DAY_MS + CHECK_FIRST_MS)
})

test('a backup is stale ten days after the last success, counted from setup before the first', (t) => {
  t.absent(isStale({ now: T0 + 100 * DAY_MS, setUp: false, lastSuccessAt: null, setupAt: null }))
  t.absent(isStale({ now: T0 + STALE_AFTER_MS, setUp: true, lastSuccessAt: T0, setupAt: T0 }))
  t.ok(isStale({ now: T0 + STALE_AFTER_MS + 1, setUp: true, lastSuccessAt: T0, setupAt: T0 }))
  t.ok(isStale({ now: T0 + STALE_AFTER_MS + 1, setUp: true, lastSuccessAt: null, setupAt: T0 }))
})

test('a fresh setup is not stale on an older folder\'s last success', (t) => {
  const lastSuccessAt = T0
  const setupAt = T0 + 30 * DAY_MS
  t.absent(isStale({ now: setupAt + DAY_MS, setUp: true, lastSuccessAt, setupAt }))
  t.ok(isStale({ now: setupAt + STALE_AFTER_MS + 1, setUp: true, lastSuccessAt, setupAt }))
})

test('a key found in the folder is unconfirmed and gets its first check', (t) => {
  const state = keyAdopted({ ...freshState(), secondCopyAt: T0 }, T0, KEY)
  t.is(state.keyCheckedAt, null)
  t.is(state.secondCopyAt, null)
  t.is(state.check.nextAt, T0 + CHECK_FIRST_MS)
  t.is(backupPrompt({ now: T0 + CHECK_FIRST_MS, setUp: true, eligible: true, state }), PROMPT.CHECK)
})

test('a key from another identity is forgotten, the opt-out is kept', (t) => {
  const state = keyForgotten(optedOut(keyChecked(keyWritten(freshState(), T0, KEY), T0)))
  t.is(state.keyContent, null)
  t.is(state.keyCreatedAt, null)
  t.is(state.keyCheckedAt, null)
  t.is(state.check.nextAt, null)
  t.ok(state.check.optOut)
})

test('the verdict and its reason, cause by cause', (t) => {
  const healthy = { ...keyChecked(keyWritten(folderChosen(freshState(), T0), T0, KEY), T0), lastSuccessAt: T0 }
  const verdict = (state, { setUp = true, stale = false, failing = false } = {}) => protectionVerdict({ setUp, stale, failing, state })
  t.alike(verdict(freshState(), { setUp: false }), { verdict: VERDICT.AT_RISK, reason: VERDICT_REASON.NOT_SET_UP })
  t.alike(verdict(healthy), { verdict: VERDICT.PROTECTED, reason: null })
  t.is(verdict({ ...healthy, secondCopyAt: null }).verdict, VERDICT.PROTECTED, 'a missing copy is advice, not a lapse')
  t.alike(verdict(healthy, { failing: true }), { verdict: VERDICT.AT_RISK, reason: VERDICT_REASON.FAILING })
  t.alike(verdict({ ...healthy, lastSuccessAt: null }), { verdict: VERDICT.AT_RISK, reason: VERDICT_REASON.FIRST_BACKUP })
  t.alike(verdict({ ...healthy, keyInFolder: false }), { verdict: VERDICT.AT_RISK, reason: VERDICT_REASON.KEY_NOT_IN_FOLDER })
  t.alike(verdict({ ...healthy, keyCheckedAt: null }), { verdict: VERDICT.AT_RISK, reason: VERDICT_REASON.UNCONFIRMED })
  t.alike(verdict(healthy, { stale: true }), { verdict: VERDICT.STOPPED, reason: VERDICT_REASON.STALE })
  t.alike(verdict({ ...healthy, keyCreatedAt: null, keyContent: null }), { verdict: VERDICT.STOPPED, reason: VERDICT_REASON.NO_KEY })
})

test('the passphrase reminder is a preference that can be turned back on', (t) => {
  const due = keyWritten(folderChosen(freshState(), T0), T0, KEY)
  const off = remindersSet(due, false, T0)
  t.is(backupPrompt({ now: T0 + CHECK_FIRST_MS, setUp: true, eligible: true, state: off }), null)
  const later = T0 + 400 * DAY_MS
  const on = remindersSet(off, true, later)
  t.is(backupPrompt({ now: later, setUp: true, eligible: true, state: on }), null, 'a check missed while off is not asked at once')
  t.is(backupPrompt({ now: later + CHECK_FIRST_MS, setUp: true, eligible: true, state: on }), PROMPT.CHECK)
})
