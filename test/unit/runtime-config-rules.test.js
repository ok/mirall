import test from 'brittle'
import {
  setRuntimeConfig, getRuntimeConfig, getRelayConfig, setRelayConfig,
  getListFilesCap, getMaxFilesPerShare, getServeChunkMapCacheBytes,
  getPublishConcurrency, getDownloadConcurrency, getPeerFrameMaxBytes, getPeerCatalogCacheLimit,
  getPeerFrameLimits, getHandshakeRateLimit, getBandwidthLimits,
  getSupervisionRecoverBudgetMs, getReconcileStallWindowMs, getPublishStallWindowMs,
  getConvergenceStallWindowMs, _rulesForTests,
} from '../../src/shared/core/runtime-config.js'

// Every value a malformed override can take that is not a number: each must resolve to the key's
// documented fallback rather than reaching the subsystem that reads it.
const MALFORMED = [-1, NaN, 'nope', null, {}, [], true]

// One row per key that carries a validation rule: [key, reader, default, [[override, expected], ...]].
// The expectations are the behaviour the module already has — transcribed by reading each getter and
// confirmed by running it, not by predicting what a rule "should" do. Two families are deliberately
// asymmetric and are the rows most likely to be "corrected" into a regression:
//   - publishConcurrency honours an explicit Infinity ("run every item at once"); downloadConcurrency
//     does not, because 0 already means unbounded there, so an Infinity is a malformed value.
//   - a fractional CAP is admitted (listFilesCap 0.5), a fractional SLOT COUNT is floored.
const RULED_KEYS = [
  // Deadlines. Both DEFAULTED sentinels invert for a deadline: 0 condemns every pass the instant it
  // starts, and Infinity reaches setTimeout, which clamps it to about a millisecond.
  ['supervisionRecoverBudgetMs', getSupervisionRecoverBudgetMs, 10_000,
    [[0, 10_000], [Infinity, 10_000], [1, 1], [1234, 1234], [0.5, 10_000]]],
  ['reconcileStallWindowMs', getReconcileStallWindowMs, 600_000,
    [[0, 600_000], [Infinity, 600_000], [1, 1], [1234, 1234]]],
  ['publishStallWindowMs', getPublishStallWindowMs, 600_000,
    [[0, 600_000], [Infinity, 600_000], [1, 1], [1234, 1234]]],
  ['convergenceStallWindowMs', getConvergenceStallWindowMs, 300_000,
    [[0, 300_000], [Infinity, 300_000], [1, 1], [1234, 1234]]],

  // Lane budgets whose 0 is a real override ("switch the lane off" / "no size bound").
  ['peerFrameMaxBytes', getPeerFrameMaxBytes, 65536,
    [[0, 0], [Infinity, 65536], [1, 1], [4096, 4096]]],
  ['peerCatalogCacheLimit', getPeerCatalogCacheLimit, 64,
    [[0, 0], [Infinity, 64], [1, 1], [8, 8]]],

  // Slot counts.
  ['publishConcurrency', getPublishConcurrency, 2,
    [[0, 2], [Infinity, Infinity], [1, 1], [3, 3], [2.9, 2], [-4, 2]]],
  ['downloadConcurrency', getDownloadConcurrency, 6,
    [[0, 0], [Infinity, 6], [1, 1], [6.7, 6], [-1, 6]]],

  // Protective caps whose escape hatch is "uncapped", returned as Infinity so callers compare freely.
  ['listFilesCap', getListFilesCap, 5000,
    [[0, Infinity], [Infinity, Infinity], [10, 10], [0.5, 0.5]]],
  ['maxFilesPerShare', getMaxFilesPerShare, 5000,
    [[0, Infinity], [Infinity, Infinity], [10, 10]]],

  // A memory bound, so its two sentinels stay distinct: 0 is "no cache", never "no bound".
  ['serveChunkMapCacheBytes', getServeChunkMapCacheBytes, 32 * 1024 * 1024,
    [[0, 0], [Infinity, Infinity], [4096, 4096]]],

  // Inverted polarity: a user convenience, so a malformed value returns to UNLIMITED (0) rather than
  // throttling every transfer to a crawl. Reported in bytes/s.
  ['downloadKBps', () => getBandwidthLimits().download, 0,
    [[0, 0], [Infinity, 0], [5120, 5120 * 1024], [-1, 0]]],
  ['uploadKBps', () => getBandwidthLimits().upload, 0,
    [[0, 0], [Infinity, 0], [1024, 1024 * 1024], [-1, 0]]],
]

for (const [key, read, dflt, rows] of RULED_KEYS) {
  test(`validation rule: ${key}`, (t) => {
    const saved = getRuntimeConfig()
    t.teardown(() => setRuntimeConfig(saved))

    setRuntimeConfig({ ...saved })
    t.is(read(), dflt, `${key} resolves to its default`)

    for (const [override, expected] of rows) {
      setRuntimeConfig({ ...saved, [key]: override })
      t.is(read(), expected, `${key}: ${String(override)} resolves to ${String(expected)}`)
    }

    for (const bad of MALFORMED) {
      setRuntimeConfig({ ...saved, [key]: bad })
      t.is(read(), dflt, `${key}: ${String(bad)} falls back`)
    }
  })
}

// Two cells of one returned object, validated differently: burst admits 0 because 0 is how the lane
// is switched off, while refill and threshold do not because a 0 refill divides and a 0 threshold
// bans on the first frame.
test('peer-frame lane: burst admits 0, refill and threshold do not', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  setRuntimeConfig({ ...saved })
  t.alike(getPeerFrameLimits(), { burst: 256, refillMs: 20, abuseThreshold: 512 }, 'documented defaults')

  setRuntimeConfig({ ...saved, peerFrameBurst: 0 })
  t.is(getPeerFrameLimits().burst, 0, '0 switches the lane off — a real override')

  setRuntimeConfig({ ...saved, peerFrameRefillMs: 0, peerFrameAbuseThreshold: 0 })
  const lane = getPeerFrameLimits()
  t.is(lane.refillMs, 20, 'a 0 refill would divide; falls back')
  t.is(lane.abuseThreshold, 512, 'a 0 threshold would ban on the first frame; falls back')

  setRuntimeConfig({ ...saved, peerFrameBurst: -1, peerFrameRefillMs: Infinity })
  const bad = getPeerFrameLimits()
  t.is(bad.burst, 256, 'a negative burst drops every honest frame; falls back')
  t.is(bad.refillMs, 20, 'an Infinite refill never decays; falls back')
})

// The asymmetry inside the matched handshake lane: burstPerTopic multiplies a live per-socket count,
// so it is the one cell that is validated. Pinning the raw cells here is what makes giving one of
// them a rule a deliberate change rather than a quiet one.
test('handshake matched lane: burstPerTopic is validated, its siblings are read raw', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  setRuntimeConfig({ ...saved, handshakeBurstPerTopic: Infinity })
  t.is(getHandshakeRateLimit().matched.burstPerTopic, 3, 'Infinity would make the product NaN')

  setRuntimeConfig({ ...saved, handshakeBurstPerTopic: -1 })
  t.is(getHandshakeRateLimit().matched.burstPerTopic, 3, 'a negative would drop every honest frame')

  setRuntimeConfig({ ...saved, handshakeBurstPerTopic: 0 })
  t.is(getHandshakeRateLimit().matched.burstPerTopic, 0, '0 restores the fixed burst — a real override')

  setRuntimeConfig({ ...saved, handshakeBurst: -5, handshakeAbuseThreshold: -5 })
  const lane = getHandshakeRateLimit().matched
  t.is(lane.burst, -5, 'burst carries no rule today')
  t.is(lane.abuseThreshold, -5, 'abuseThreshold carries no rule today')
})

// setRuntimeConfig({ ...getRuntimeConfig(), x }) is the shape the live setters use. A coercion group
// that is not idempotent under its own output corrupts the config on the second pass.
test('re-ingesting a built config is a no-op', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  setRuntimeConfig({
    storage: '/tmp/s', downloadFolder: '', listFilesCap: 0, relayMode: 'auto',
    relay: { key: 'ab' }, publishOrder: 'random', overlayEnabled: false, downloadKBps: -3,
    peerFrameRefillMs: 0, dev: 1,
  })
  const once = getRuntimeConfig()
  setRuntimeConfig({ ...once })
  t.alike(getRuntimeConfig(), once, 'a second pass changes nothing')
})

// The relay mode is coerced on two paths — the bootstrap frame and the live setter — and they must
// agree, because a mode the live setter admits but the bootstrap rejects would not survive a restart.
test('both relay-mode paths coerce identically', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  for (const mode of ['auto', 'always', 'off', 'ALWAYS', '', null, undefined, 7]) {
    setRuntimeConfig({ ...saved, relayMode: mode, relay: null })
    const viaBootstrap = getRelayConfig().mode
    setRelayConfig(mode, null)
    t.is(getRelayConfig().mode, viaBootstrap, `${String(mode)} coerces the same on both paths`)
  }
})

// The 17 keys that carry a validation rule, and the 46 that do not. A key absent from this map is
// read RAW — including every getResourceCaps cell and three of the four cells of the matched
// handshake lane. Adding a row changes a DoS bound or a user-facing cap: do it deliberately, with
// the behaviour test that proves the new rule, and update this expectation in the same change.
const EXPECTED_RULES = {
  supervisionRecoverBudgetMs: { rule: 'finiteAtLeast', min: 1 },
  reconcileStallWindowMs: { rule: 'finiteAtLeast', min: 1 },
  publishStallWindowMs: { rule: 'finiteAtLeast', min: 1 },
  convergenceStallWindowMs: { rule: 'finiteAtLeast', min: 1 },
  peerFrameRefillMs: { rule: 'finiteAtLeast', min: 1 },
  peerFrameAbuseThreshold: { rule: 'finiteAtLeast', min: 1 },
  peerFrameBurst: { rule: 'finiteAtLeast', min: 0 },
  peerFrameMaxBytes: { rule: 'finiteAtLeast', min: 0 },
  peerCatalogCacheLimit: { rule: 'finiteAtLeast', min: 0 },
  handshakeBurstPerTopic: { rule: 'finiteAtLeast', min: 0 },
  publishConcurrency: { rule: 'intAtLeastOrInfinity', min: 1 },
  downloadConcurrency: { rule: 'intAtLeast', min: 0 },
  listFilesCap: { rule: 'capOrInfinity', min: undefined },
  maxFilesPerShare: { rule: 'capOrInfinity', min: undefined },
  serveChunkMapCacheBytes: { rule: 'boundedOrSentinel', min: undefined },
  downloadKBps: { rule: 'failOpen', min: undefined },
  uploadKBps: { rule: 'failOpen', min: undefined },
}

test('the rules table is exactly the declared set', (t) => {
  t.alike(_rulesForTests().ruled, EXPECTED_RULES, 'no rule added, removed or re-bound')
})

// The module header states these two counts. Asserting them is what keeps them from rotting.
test('the ruled and unruled key counts are the ones the header claims', (t) => {
  const { ruled, defaultedKeys } = _rulesForTests()
  t.is(defaultedKeys, 63, 'DEFAULTED keys')
  t.is(Object.keys(ruled).length, 17, 'of which carry a validation rule')
  t.is(defaultedKeys - Object.keys(ruled).length, 46, 'the rest are read raw')
})

test('every ruled key is a DEFAULTED key', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  setRuntimeConfig({})
  const built = getRuntimeConfig()
  for (const key of Object.keys(_rulesForTests().ruled)) {
    t.ok(key in built, `${key} is built into the live config`)
  }
})
