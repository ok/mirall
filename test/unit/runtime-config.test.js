import {
  setRuntimeConfig, setDownloadFolder, setBandwidthLimits, getBandwidthLimits, getRuntimeConfig,
  getResourceCaps, getHandshakeRateLimit, getConvergenceConfig, getIdentityFrameDropWindow, getServeChunkMapCacheBytes } from '../../src/shared/core/runtime-config.js'
import test from 'brittle'

import { AVATAR_MAX_BYTES } from '../../src/shared/identity-limits.js'

test('downloadFolder defaults to null when not provided in bootstrap', (t) => {
  setRuntimeConfig({})
  t.is(getRuntimeConfig().downloadFolder, null)
})

test('interactiveReadTimeoutMs defaults to 1500, overrides, and honors 0; independent of peerReadTimeoutMs', (t) => {
  setRuntimeConfig({})
  t.is(getRuntimeConfig().interactiveReadTimeoutMs, 1500, 'short list budget defaults to 1.5s')
  setRuntimeConfig({ interactiveReadTimeoutMs: 250, peerReadTimeoutMs: 9000 })
  t.is(getRuntimeConfig().interactiveReadTimeoutMs, 250, 'override applied')
  t.is(getRuntimeConfig().peerReadTimeoutMs, 9000, 'the peer read budget is a separate field')
  setRuntimeConfig({ interactiveReadTimeoutMs: 0 })
  t.is(getRuntimeConfig().interactiveReadTimeoutMs, 0, '0 honored (DEFAULTED nullish-only fallback)')
  setRuntimeConfig({})
})

test('downloadFolder is read from bootstrap payload', (t) => {
  setRuntimeConfig({ downloadFolder: '/tmp/mirall-test-bootstrap' })
  t.is(getRuntimeConfig().downloadFolder, '/tmp/mirall-test-bootstrap')
})

test('empty downloadFolder string is normalised to null', (t) => {
  setRuntimeConfig({ downloadFolder: '' })
  t.is(getRuntimeConfig().downloadFolder, null)
})

test('setDownloadFolder updates the value at runtime without touching other fields', (t) => {
  setRuntimeConfig({
    storage: '/tmp/storage',
    appVersion: '1.2.3',
    dev: true,
    verbose: true,
    downloadFolder: '/tmp/initial',
  })

  setDownloadFolder('/tmp/changed')
  const cfg = getRuntimeConfig()

  t.is(cfg.downloadFolder, '/tmp/changed')
  t.is(cfg.storage, '/tmp/storage')
  t.is(cfg.appVersion, '1.2.3')
  t.is(cfg.dev, true)
  t.is(cfg.verbose, true)
})

test('spread round-trip flips verbose while preserving every other field (setVerbose handler)', (t) => {
  // window.mirall.verbose drives the worker's setVerbose handler, which does
  // setRuntimeConfig({ ...getRuntimeConfig(), verbose }). Guard that this
  // preserves the rest of the live config.
  setRuntimeConfig({
    storage: '/tmp/storage',
    appVersion: '1.2.3',
    dev: true,
    verbose: false,
    downloadFolder: '/tmp/dl',
  })

  setRuntimeConfig({ ...getRuntimeConfig(), verbose: true })
  let cfg = getRuntimeConfig()
  t.is(cfg.verbose, true, 'verbose flipped on')
  t.is(cfg.storage, '/tmp/storage', 'storage preserved')
  t.is(cfg.appVersion, '1.2.3', 'appVersion preserved')
  t.is(cfg.dev, true, 'dev preserved')
  t.is(cfg.downloadFolder, '/tmp/dl', 'downloadFolder preserved')

  setRuntimeConfig({ ...getRuntimeConfig(), verbose: false })
  cfg = getRuntimeConfig()
  t.is(cfg.verbose, false, 'verbose flipped back off')
  t.is(cfg.downloadFolder, '/tmp/dl', 'other fields still intact')

  setRuntimeConfig({})
})

test('DoS resource caps + rate limit default to the documented values', (t) => {
  setRuntimeConfig({})
  const caps = getResourceCaps()
  t.is(caps.serverConnections, 32, 'server connections')
  t.is(caps.clientConnections, 32, 'client connections')
  t.is(caps.pendingRequesters, 64, 'pending requesters')
  t.is(caps.membersPerSpace, 256, 'members per space')
  t.is(caps.approvalsPerMember, 128, 'approvals per member')
  t.is(caps.requestsPerMember, 64, 'requests per member')
  t.is(caps.avatarMaxBytes, 256 * 1024, 'avatar byte cap')
  t.is(caps.deriveDebounceMs, 150, 'derive debounce')

  const rl = getHandshakeRateLimit()
  t.is(rl.matched.burst, 8, 'matched-lane burst')
  t.is(rl.matched.refillMs, 1000, 'matched-lane refill')
  t.is(rl.matched.abuseThreshold, 24, 'matched-lane abuse threshold')
  t.is(rl.unmatched.burst, 32, 'unmatched-lane burst')
  t.is(rl.unmatched.refillMs, 250, 'unmatched-lane refill')
  t.is(rl.unmatched.abuseThreshold, 256, 'unmatched-lane abuse threshold')

  const cc = getConvergenceConfig()
  t.is(cc.convergenceTickMs, 15_000, 'convergence tick cadence')
  t.is(cc.announceBaseMs, 10_000, 'announce backoff base')
  t.is(cc.announceCapMs, 60_000, 'announce backoff cap')
  t.is(cc.announceMaxAttempts, 4, 'announce give-up for handshakes')
  t.is(cc.dupReciprocalFloorMs, 10_000, 'duplicate-reciprocal floor')
  t.is(cc.convergenceEscalateTicks, 4, 'deficit ticks before escalation')
  t.is(cc.convergenceRefreshMinMs, 300_000, 'min gap between discovery refreshes')
  t.is(cc.convergenceMaxEscalations, 3, 'escalation give-up per unchanged deficit')

  const dw = getIdentityFrameDropWindow()
  t.is(dw.after, 0, 'test drop lever off by default (after)')
  t.is(dw.count, 0, 'test drop lever off by default (count)')
})

test('resource caps coerce overrides, including the 0 / Infinity escape hatches', (t) => {
  setRuntimeConfig({ maxApprovalsPerMember: 0, handshakeBurst: 2 })
  t.is(getResourceCaps().approvalsPerMember, 0, '0 disables the cap')
  t.is(getHandshakeRateLimit().matched.burst, 2, 'rate-limit override applied')

  setRuntimeConfig({ maxServerConnections: Infinity })
  t.is(getResourceCaps().serverConnections, Infinity, 'Infinity disables the connection cap')

  setRuntimeConfig({ convergenceTickMs: 0, testDropIdentityFramesCount: 3 })
  t.is(getConvergenceConfig().convergenceTickMs, 0, '0 disables the convergence tick')
  t.is(getIdentityFrameDropWindow().count, 3, 'test drop lever override applied')

  setRuntimeConfig({})
  t.is(getHandshakeRateLimit().matched.burst, 8, 'rate limit normalised back to default')
})

// The always-on defaults: each ships enabled and only an explicit `false` reverts it, so an
// absent/partial bootstrap can never silently disable them. sharePrepareProgress drives the
// receiver's "preparing NN%" decoration while an owner (re-)hashes a shared file.
test('overlay, in-place files, the content plane and prepare-progress default ON; explicit false reverts', (t) => {
  setRuntimeConfig({})
  const on = getRuntimeConfig()
  t.ok(on.overlayEnabled, 'overlay on by default')
  t.ok(on.inPlaceFilesEnabled, 'in-place files on by default')
  t.ok(on.separateContentPlane, 'content plane on by default')
  t.ok(on.sharePrepareProgressEnabled, 'share-prepare progress on by default')

  setRuntimeConfig({ sharePrepareProgressEnabled: false, separateContentPlane: false })
  const off = getRuntimeConfig()
  t.absent(off.sharePrepareProgressEnabled, 'an explicit false reverts prepare-progress')
  t.absent(off.separateContentPlane, 'an explicit false reverts the content plane')

  setRuntimeConfig({ sharePrepareProgressEnabled: undefined })
  t.ok(getRuntimeConfig().sharePrepareProgressEnabled, 'an absent flag stays ON — only false disables')
  setRuntimeConfig({})
})

test('REGRESSION (FIX-MIR-12): avatar cap default matches AVATAR_MAX_BYTES', (t) => {
  setRuntimeConfig({})
  t.is(getResourceCaps().avatarMaxBytes, AVATAR_MAX_BYTES, 'runtime-config default tracks the shared constant')
  setRuntimeConfig({ maxAvatarBytes: 1024 })
  t.is(getResourceCaps().avatarMaxBytes, 1024, 'override applied')
  setRuntimeConfig({ maxAvatarBytes: 0 })
  t.is(getResourceCaps().avatarMaxBytes, 0, '0 disables the bound')
  setRuntimeConfig({})
})

test('bandwidth limits default to unlimited and convert KB/s to bytes/s', (t) => {
  setRuntimeConfig({})
  t.alike(getBandwidthLimits(), { download: 0, upload: 0 }, '0 = unlimited on both directions')
  setRuntimeConfig({ downloadKBps: 5120, uploadKBps: 1024 })
  t.alike(getBandwidthLimits(), { download: 5120 * 1024, upload: 1024 * 1024 }, 'converted to bytes/s')
  setRuntimeConfig({})
})

// Inverted fail-safe: these are a user convenience, not a protective bound, so a corrupt
// value must return to UNLIMITED rather than throttle every transfer to a crawl.
test('a corrupt bandwidth value fails OPEN, not closed', (t) => {
  for (const bad of [-1, NaN, Infinity, '5000', {}, null]) {
    setRuntimeConfig({ downloadKBps: bad, uploadKBps: bad })
    t.alike(getBandwidthLimits(), { download: 0, upload: 0 }, `${String(bad)} falls back to unlimited`)
  }
  setRuntimeConfig({})
})

test('setBandwidthLimits updates live and leaves the rest of the config alone', (t) => {
  setRuntimeConfig({ downloadFolder: '/tmp/dl', downloadKBps: 100 })
  setBandwidthLimits({ downloadKBps: 2048, uploadKBps: 512 })
  t.alike(getBandwidthLimits(), { download: 2048 * 1024, upload: 512 * 1024 }, 'new caps applied')
  t.is(getRuntimeConfig().downloadFolder, '/tmp/dl', 'unrelated config preserved')

  setBandwidthLimits({ uploadKBps: 0 })
  t.is(getBandwidthLimits().upload, 0, '0 is honoured — it means unlimited')
  t.is(getBandwidthLimits().download, 2048 * 1024, 'an omitted direction keeps its value')

  setBandwidthLimits({ downloadKBps: 'nonsense' })
  t.is(getBandwidthLimits().download, 2048 * 1024, 'an invalid value keeps the previous cap')
  setRuntimeConfig({})
})

test('serveChunkMapCacheBytes: 32 MiB default, 0 disables, Infinity unbounds, garbage falls back', (t) => {
  setRuntimeConfig({})
  t.is(getServeChunkMapCacheBytes(), 32 * 1024 * 1024)
  setRuntimeConfig({ serveChunkMapCacheBytes: 0 })
  t.is(getServeChunkMapCacheBytes(), 0, '0 = no cache (the rollback gate)')
  setRuntimeConfig({ serveChunkMapCacheBytes: Infinity })
  t.is(getServeChunkMapCacheBytes(), Infinity)
  setRuntimeConfig({ serveChunkMapCacheBytes: 4096 })
  t.is(getServeChunkMapCacheBytes(), 4096)
  for (const bad of [-1, NaN, 'big', null]) {
    setRuntimeConfig({ serveChunkMapCacheBytes: bad })
    t.is(getServeChunkMapCacheBytes(), 32 * 1024 * 1024, `falls back on ${String(bad)}`)
  }
  setRuntimeConfig({})
})
