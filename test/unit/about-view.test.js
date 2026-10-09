import test from 'brittle'
import { updateVerdict, updateDot, updateSummaryKey, releaseChannel } from '../../src/renderer/model/about-view.js'

const BASE = { state: 'idle', nextVersion: null, lastCheckedAt: null, offReason: null, canRestart: true }
const status = (patch) => ({ ...BASE, ...patch })

test('only a confirmed check is up to date', (t) => {
  t.alike(updateVerdict(BASE), { lamp: 'neutral', key: 'notChecked', action: 'check' })
  t.alike(updateVerdict(status({ lastCheckedAt: 1 })), { lamp: 'up-to-date', key: 'upToDate', action: 'check' })
  t.is(updateDot(BASE), null, 'an unchecked build gets no dot')
  t.is(updateDot(status({ lastCheckedAt: 1 })), 'up-to-date')
})

test('each update state names its verdict and its one action', (t) => {
  t.alike(updateVerdict(status({ state: 'checking' })), { lamp: 'neutral', key: 'checking', action: 'check' })
  t.alike(updateVerdict(status({ state: 'downloading' })), { lamp: 'neutral', key: 'downloading', action: null })
  t.alike(updateVerdict(status({ state: 'ready', nextVersion: '2.0.0' })), { lamp: 'ready', key: 'ready', action: 'restart' })
  t.alike(updateVerdict(status({ state: 'ready', canRestart: false })), { lamp: 'ready', key: 'ready', action: null }, 'no restart where a relaunch cannot start the new build')
  t.alike(updateVerdict(status({ state: 'error' })), { lamp: 'neutral', key: 'error', action: 'check' })
  t.alike(updateVerdict(status({ state: 'off', offReason: 'deb-install' })), { lamp: 'neutral', key: 'offDeb', action: null })
  t.alike(updateVerdict(status({ state: 'off', offReason: 'no-upgrade-key' })), { lamp: 'neutral', key: 'off', action: null })
  t.is(updateDot(status({ state: 'ready' })), 'ready')
})

test('the Profile row only says what the status proves', (t) => {
  t.is(updateSummaryKey(BASE), null)
  t.is(updateSummaryKey(status({ state: 'error' })), null)
  t.is(updateSummaryKey(status({ state: 'off', offReason: 'flag' })), null)
  t.is(updateSummaryKey(status({ lastCheckedAt: 1 })), 'about.summary.upToDate')
  t.is(updateSummaryKey(status({ state: 'ready' })), 'about.summary.ready')
  t.is(updateSummaryKey(status({ state: 'off', offReason: 'deb-install' })), 'about.summary.offDeb')
})

test('the channel comes from the baked version', (t) => {
  t.is(releaseChannel('1.12.0', false), 'release')
  t.is(releaseChannel('1.12.0-beta.66', false), 'beta')
  t.is(releaseChannel('1.12.0-dev.4', false), 'dev')
  t.is(releaseChannel('1.12.0', true), 'source')
})
