import test from 'brittle'
import { updateVerdict, updateDot, updateDownload, updateSummaryKey, releaseChannel } from '../../src/renderer/model/about-view.js'

const BASE = { state: 'idle', nextVersion: null, lastCheckedAt: null, offReason: null, canRestart: true, progress: null, waitingForPeers: false, mode: 'automatic', held: false }
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

test('only a download has a bar', (t) => {
  for (const state of ['idle', 'checking', 'ready', 'error', 'off']) t.is(updateDownload(status({ state })), null, state)
})

test('the bar sweeps until the download is sized, then shows the percentage', (t) => {
  t.alike(updateDownload(status({ state: 'downloading' })), { percent: null, indeterminate: true, bodyKey: 'downloading' })
  t.alike(updateDownload(status({ state: 'downloading', progress: 42 })), { percent: 42, indeterminate: false, bodyKey: 'downloading' })
  t.alike(updateDownload(status({ state: 'downloading', progress: 0 })), { percent: 0, indeterminate: false, bodyKey: 'downloading' })
})

test('a download waiting for a peer says so and stands still', (t) => {
  t.alike(updateDownload(status({ state: 'downloading', progress: 42, waitingForPeers: true })), { percent: 42, indeterminate: false, bodyKey: 'downloadingWaiting' })
  t.alike(updateDownload(status({ state: 'downloading', waitingForPeers: true })), { percent: null, indeterminate: false, bodyKey: 'downloadingWaiting' })
})

test('the Profile row says the same whatever the download has reached', (t) => {
  t.is(updateSummaryKey(status({ state: 'downloading' })), 'about.summary.downloading')
  t.is(updateSummaryKey(status({ state: 'downloading', progress: 42, waitingForPeers: true })), 'about.summary.downloading')
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

test('a version waiting for the go-ahead offers Update and wears its own dot', (t) => {
  const s = status({ state: 'available', nextVersion: '2.0.0', mode: 'notify' })
  t.alike(updateVerdict(s), { lamp: 'available', key: 'available', action: 'install' })
  t.is(updateDot(s), 'available')
  t.is(updateSummaryKey(s), 'about.summary.available')
})

test('a held download says it will not install on its own', (t) => {
  t.is(updateDownload(status({ state: 'downloading', progress: 10, held: true })).bodyKey, 'downloadingHeld')
  t.is(updateDownload(status({ state: 'downloading', progress: 10, held: true, waitingForPeers: true })).bodyKey, 'downloadingWaiting', 'a stalled download says why it stalls first')
})
