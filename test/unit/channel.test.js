import test from 'brittle'
import { deriveChannel, versionLabel } from '../../src/shared/contract/release-channel.js'

test('deriveChannel — dev flag wins regardless of version', (t) => {
  t.is(deriveChannel({ dev: true }), 'dev')
  t.is(deriveChannel({ dev: true, appVersion: '1.5.3' }), 'dev')
})

test('deriveChannel — beta suffix maps to staging', (t) => {
  t.is(deriveChannel({ appVersion: '1.5.3-beta.42' }), 'staging')
})

test('deriveChannel — legacy staging suffix still maps to staging', (t) => {
  t.is(deriveChannel({ appVersion: '1.5.3-staging.42' }), 'staging')
})

test('deriveChannel — dev suffix maps to dev', (t) => {
  t.is(deriveChannel({ appVersion: '1.5.3-dev.7' }), 'dev')
})

test('deriveChannel — bare semver and empty/absent config map to prod', (t) => {
  t.is(deriveChannel({ appVersion: '1.5.3' }), 'prod')
  t.is(deriveChannel({}), 'prod')
  t.is(deriveChannel(), 'prod')
})

// One rule for the text a back end states and the text main compares it with: the version itself,
// beta number included, and a fixed word only for a build that has none.
test('versionLabel — the version as built, or what a build without one is', (t) => {
  t.is(versionLabel({ dev: true, appVersion: '1.14.0-beta.3' }), '1.14.0-beta.3', 'the dev flag does not replace a version')
  t.is(versionLabel({ appVersion: '1.14.0' }), '1.14.0')
  t.is(versionLabel({ dev: true, appVersion: null }), 'dev')
  t.is(versionLabel({}), 'unknown')
})
