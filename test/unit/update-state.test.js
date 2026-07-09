import test from 'brittle'
import { initialUpdateState, reduceDetectedUpdate, reduceDismissed } from '../../src/renderer/updateState.js'

const v = (semver, length = 0, fork = 0) => ({ fork, length, semver })

test('initial state has no update and is not dismissed', (t) => {
  t.alike(initialUpdateState, { update: null, dismissed: false })
})

test('reduceDetectedUpdate records the staged version', (t) => {
  const next = reduceDetectedUpdate(initialUpdateState, v('1.7.0', 100))
  t.is(next.update.app, true)
  t.alike(next.update.version, { fork: 0, length: 100, semver: '1.7.0' })
  t.is(next.dismissed, false)
})

test('re-announcing the same version preserves a prior dismissal (no nagging)', (t) => {
  const dismissed = { update: { app: true, version: v('1.7.0', 100) }, dismissed: true }
  const next = reduceDetectedUpdate(dismissed, v('1.7.0', 100))
  t.is(next.dismissed, true, 'still dismissed — the banner stays hidden')
})

test('a different semver clears the dismissal so the banner reappears', (t) => {
  const dismissed = { update: { app: true, version: v('1.7.0', 100) }, dismissed: true }
  const next = reduceDetectedUpdate(dismissed, v('1.8.0', 120))
  t.is(next.dismissed, false)
  t.is(next.update.version.semver, '1.8.0')
})

test('a different length or fork (same/absent semver) also clears the dismissal', (t) => {
  const base = { update: { app: true, version: v(null, 100, 0) }, dismissed: true }
  t.is(reduceDetectedUpdate(base, v(null, 101, 0)).dismissed, false, 'length bump re-shows')
  t.is(reduceDetectedUpdate(base, v(null, 100, 1)).dismissed, false, 'fork bump re-shows')
})

test('reduceDismissed marks dismissed but keeps the update fact (About notice persists)', (t) => {
  const withUpdate = { update: { app: true, version: v('1.7.0', 100) }, dismissed: false }
  const next = reduceDismissed(withUpdate)
  t.is(next.dismissed, true)
  t.ok(next.update, 'update is retained so the About box can still show it')
  t.is(next.update.version.semver, '1.7.0')
})

test('reduceDismissed is idempotent — returns the same reference when already dismissed', (t) => {
  const already = { update: { app: true, version: v('1.7.0', 100) }, dismissed: true }
  t.is(reduceDismissed(already), already, 'same ref lets callers skip a redundant emit')
})
