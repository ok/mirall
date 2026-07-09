import test from 'brittle'
import { deriveChannel } from '../src/shared/core/channel.js'

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
