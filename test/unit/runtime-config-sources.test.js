import test from 'brittle'
import { assembleRuntimeConfig, flagsToRuntimeConfig, testRunToRuntimeConfig } from '../../src/shared/core/runtime-config-sources.js'
import { defaultSettings, coerceSettings } from '../../src/shared/core/settings-rules.js'
import { sanitizeRelay } from '../../src/shared/network/relay-slot.js'
import { setRuntimeConfig, getRuntimeConfig, getBandwidthLimits, getRelayConfig, isMembershipControlBindingEnforced, isTransferTraceOn, getTestRunName } from '../../src/shared/core/runtime-config.js'

const deps = { sanitizeRelay, recentLimit: 3 }

test('the two staged flags map off by default and only true turns one on', (t) => {
  t.alike(flagsToRuntimeConfig({}), { membershipControlBindingEnforced: false, topicRefsEnforced: false })
  t.alike(flagsToRuntimeConfig({ membershipControlBinding: 'yes', topicRefs: 1 }),
    { membershipControlBindingEnforced: false, topicRefsEnforced: false }, 'a truthy non-boolean is not true')
  t.alike(flagsToRuntimeConfig({ membershipControlBinding: true, topicRefs: true }),
    { membershipControlBindingEnforced: true, topicRefsEnforced: true })
  t.alike(Object.keys(flagsToRuntimeConfig({ retired: true })), ['membershipControlBindingEnforced', 'topicRefsEnforced'],
    'an unknown flag key maps to nothing')
})

test('precedence: bootstrap over settings over flags over the schema default', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))
  const settings = coerceSettings({ network: { downloadKBps: 512, relayMode: 'auto' } }, deps)

  setRuntimeConfig(assembleRuntimeConfig({ bootstrap: { storage: '/s' }, settings, flags: { membershipControlBinding: true } }))
  t.is(getBandwidthLimits().download, 512 * 1024, 'a setting beats the default')
  t.is(getRelayConfig().mode, 'auto')
  t.ok(isMembershipControlBindingEnforced(), 'a flag reaches the config')

  setRuntimeConfig(assembleRuntimeConfig({
    bootstrap: { storage: '/s', downloadKBps: 64, membershipControlBindingEnforced: false },
    settings,
    flags: { membershipControlBinding: true },
  }))
  t.is(getBandwidthLimits().download, 64 * 1024, 'the bootstrap beats a setting')
  t.absent(isMembershipControlBindingEnforced(), 'and beats a flag')

  setRuntimeConfig(assembleRuntimeConfig({ bootstrap: { storage: '/s', downloadKBps: undefined }, settings, flags: {} }))
  t.is(getBandwidthLimits().download, 512 * 1024, 'an undefined bootstrap key does not shadow a setting')
})

test('the assembly carries the host facts through untouched', (t) => {
  const out = assembleRuntimeConfig({
    bootstrap: { storage: '/s', appVersion: '1.0.0', dev: true, identityKEK: 'ab', defaultDownloadFolder: '/dl' },
    settings: defaultSettings(),
    flags: {},
  })
  t.is(out.storage, '/s')
  t.is(out.appVersion, '1.0.0')
  t.is(out.identityKEK, 'ab', 'the secret rides through to boot, which consumes it')
  t.is(out.defaultDownloadFolder, '/dl')
  t.is(out.downloadFolder, null, 'no stored folder: the default decides')
})

test('the test run file names a run and turns the trace on, and anything else in it is nothing', (t) => {
  t.alike(testRunToRuntimeConfig({ run: 'R3', trace: true }), { testRunName: 'R3', transferTrace: true })
  t.alike(testRunToRuntimeConfig({ run: 'R3' }), { testRunName: 'R3' }, 'a run alone does not trace')
  t.alike(testRunToRuntimeConfig({ run: '../etc', trace: 'yes', downloadKBps: 1 }), {}, 'a malformed name, a truthy non-boolean and an unknown key')
  for (const absent of [null, undefined, [], 'R3', 7]) t.alike(testRunToRuntimeConfig(absent), {})
})

// A lever is a value the engine or the kernel is then handed as it stands, so a mistyped file must
// not reach either: each lever is a whole number in its range or it is not there.
test('the test run file sets the transfer levers, each only in its range', (t) => {
  const all = { inflightCap: 16, stashBytes: 0, recvBufferBytes: 4194304, sendBufferBytes: 2097152, pathCheck: true, pathCheckBytes: 1073741824 }
  const out = testRunToRuntimeConfig({ run: 'R4', ...all })
  t.alike(out, { testRunName: 'R4', transferLevers: all })
  t.ok(Object.isFrozen(out.transferLevers))
  t.alike(testRunToRuntimeConfig({ inflightCap: 2 }), { transferLevers: { inflightCap: 2 } }, 'one lever alone')
  const bad = { inflightCap: 0, stashBytes: -1, recvBufferBytes: 1024, sendBufferBytes: 1e12, pathCheck: 'yes', pathCheckBytes: 5 }
  t.alike(testRunToRuntimeConfig(bad), {}, 'out of range, and a truthy non-boolean')
  t.alike(testRunToRuntimeConfig({ inflightCap: 2.5, stashBytes: '16', recvBufferBytes: NaN, pathCheckBytes: Infinity }), {}, 'not a whole number')
})

test('no test run file leaves the app as shipped; the bootstrap still wins over one', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))
  const settings = coerceSettings(null, deps)

  setRuntimeConfig(assembleRuntimeConfig({ bootstrap: { storage: '/s' }, settings, flags: {} }))
  t.absent(isTransferTraceOn(), 'off by default')
  t.is(getTestRunName(), null)

  setRuntimeConfig(assembleRuntimeConfig({ bootstrap: { storage: '/s' }, settings, flags: {}, testRun: { run: 'R1', trace: true } }))
  t.ok(isTransferTraceOn())
  t.is(getTestRunName(), 'R1')

  setRuntimeConfig(assembleRuntimeConfig({ bootstrap: { storage: '/s', transferTrace: false }, settings, flags: {}, testRun: { run: 'R1', trace: true } }))
  t.absent(isTransferTraceOn(), 'the bootstrap beats the file')
})
