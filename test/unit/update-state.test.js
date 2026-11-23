import test from 'brittle'
import { initialUpdateState, reduceStatus, reduceDismissed, bannerUpdate } from '../../src/renderer/platform/update-state.js'

const status = (patch) => ({ ...initialUpdateState.status, ...patch })
const ready = (version) => status({ state: 'ready', nextVersion: version })
const available = (version) => status({ state: 'available', nextVersion: version })

test('initial state is an unchecked idle status, not dismissed', (t) => {
  t.is(initialUpdateState.status.state, 'idle')
  t.is(initialUpdateState.status.lastCheckedAt, null)
  t.is(initialUpdateState.status.mode, 'automatic')
  t.is(initialUpdateState.dismissed, false)
})

test('the banner announces a staged update and one waiting for the go-ahead, nothing else', (t) => {
  t.alike(bannerUpdate(ready('1.13.0')), { kind: 'ready', version: '1.13.0' })
  t.alike(bannerUpdate(available('1.13.0')), { kind: 'available', version: '1.13.0' })
  t.is(bannerUpdate(status({ state: 'downloading', nextVersion: '1.13.0' })), null)
  t.is(bannerUpdate(status({ lastCheckedAt: 1 })), null)
})

test('the same staged version re-announced keeps a dismissal', (t) => {
  const dismissed = { status: ready('1.13.0'), dismissed: true }
  t.is(reduceStatus(dismissed, ready('1.13.0')).dismissed, true)
})

test('a waiting version re-announced by a later check keeps Later', (t) => {
  const later = { status: available('1.13.0'), dismissed: true }
  t.is(reduceStatus(later, available('1.13.0')).dismissed, true)
})

test('a different staged version clears the dismissal so the banner reappears', (t) => {
  const dismissed = { status: ready('1.13.0'), dismissed: true }
  const next = reduceStatus(dismissed, ready('1.14.0'))
  t.is(next.dismissed, false)
  t.is(next.status.nextVersion, '1.14.0')
})

test('Later on a waiting version does not hide it once it is staged', (t) => {
  const later = { status: available('1.13.0'), dismissed: true }
  t.is(reduceStatus(later, ready('1.13.0')).dismissed, false)
})

test('dismissing keeps the status so About still shows it', (t) => {
  const next = reduceDismissed({ status: ready('1.13.0'), dismissed: false })
  t.is(next.dismissed, true)
  t.alike(bannerUpdate(next.status), { kind: 'ready', version: '1.13.0' })
})

test('reduceDismissed returns the same reference when already dismissed', (t) => {
  const already = { status: ready('1.13.0'), dismissed: true }
  t.is(reduceDismissed(already), already)
})
