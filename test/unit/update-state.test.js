import test from 'brittle'
import { initialUpdateState, reduceStatus, reduceDismissed, stagedVersion } from '../../src/renderer/platform/update-state.js'

const status = (patch) => ({ ...initialUpdateState.status, ...patch })
const ready = (version) => status({ state: 'ready', nextVersion: version })

test('initial state is an unchecked idle status, not dismissed', (t) => {
  t.is(initialUpdateState.status.state, 'idle')
  t.is(initialUpdateState.status.lastCheckedAt, null)
  t.is(initialUpdateState.dismissed, false)
})

test('only a ready status has a staged version', (t) => {
  t.is(stagedVersion(ready('1.13.0')), '1.13.0')
  t.is(stagedVersion(status({ state: 'downloading' })), null)
  t.is(stagedVersion(status({ lastCheckedAt: 1 })), null)
})

test('the same staged version re-announced keeps a dismissal', (t) => {
  const dismissed = { status: ready('1.13.0'), dismissed: true }
  t.is(reduceStatus(dismissed, ready('1.13.0')).dismissed, true)
})

test('a different staged version clears the dismissal so the banner reappears', (t) => {
  const dismissed = { status: ready('1.13.0'), dismissed: true }
  const next = reduceStatus(dismissed, ready('1.14.0'))
  t.is(next.dismissed, false)
  t.is(next.status.nextVersion, '1.14.0')
})

test('dismissing keeps the status so About still shows it', (t) => {
  const next = reduceDismissed({ status: ready('1.13.0'), dismissed: false })
  t.is(next.dismissed, true)
  t.is(stagedVersion(next.status), '1.13.0')
})

test('reduceDismissed returns the same reference when already dismissed', (t) => {
  const already = { status: ready('1.13.0'), dismissed: true }
  t.is(reduceDismissed(already), already)
})
