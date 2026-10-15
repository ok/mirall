import test from 'brittle'
import { assembleRuntimeConfig, flagsToRuntimeConfig } from '../../src/shared/core/runtime-config-sources.js'
import { defaultSettings, coerceSettings } from '../../src/shared/core/settings-rules.js'
import { sanitizeRelay } from '../../src/shared/network/relay-slot.js'
import { setRuntimeConfig, getRuntimeConfig, getBandwidthLimits, getRelayConfig, isMembershipControlBindingEnforced } from '../../src/shared/core/runtime-config.js'

const deps = { sanitizeRelay }

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
