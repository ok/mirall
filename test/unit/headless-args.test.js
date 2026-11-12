import test from 'brittle'
import { headlessBootstrap } from '../../src/worker/headless-args.js'
import { assembleRuntimeConfig } from '../../src/shared/core/runtime-config-sources.js'
import { defaultSettings } from '../../src/shared/core/settings-rules.js'

const pkg = { name: 'mirall', productName: 'Mirall', version: '1.2.3' }
const linux = { env: {}, platform: 'linux', homedir: '/home/ana', pkg }
const run = (argv, over = {}) => headlessBootstrap({ ...linux, argv, ...over })

test('no arguments open the desktop app\'s store, waiting for its key', (t) => {
  const { bootstrap } = run([])
  t.alike(bootstrap, {
    storage: '/home/ana/.config/Mirall/app-storage',
    appVersion: '1.2.3',
    upgradeKey: null,
    dev: true,
    verbose: undefined,
  })
  t.absent('identityKEK' in bootstrap, 'no key: a client hands it over')
  t.absent('relaySeed' in bootstrap)
})

test('--storage names the data folder, and the store is inside it as the desktop app keeps it', (t) => {
  t.is(run(['--storage', '/tmp/p']).bootstrap.storage, '/tmp/p/app-storage')
  t.is(run(['--storage=/tmp/q']).bootstrap.storage, '/tmp/q/app-storage')
  const win = run(['--storage', 'D:\\data'], { platform: 'win32', homedir: 'C:\\Users\\ana' })
  t.is(win.bootstrap.storage, 'D:\\data\\app-storage')
})

test('verbosity: the flag, then MIRALL_VERBOSE, else the stored choice stands', (t) => {
  t.is(run(['--verbose']).bootstrap.verbose, true)
  t.is(run([], { env: { MIRALL_VERBOSE: '1' } }).bootstrap.verbose, true)
  t.is(run([], { env: { MIRALL_VERBOSE: '0' } }).bootstrap.verbose, undefined)
  const config = assembleRuntimeConfig({ bootstrap: run([]).bootstrap, settings: defaultSettings(), flags: {} })
  t.absent('verbose' in config, 'an unset verbose leaves the key to the lower sources')
})

test('the test levers need --dev', (t) => {
  t.is(run(['--dht-bootstrap', '127.0.0.1:1']).refusal, 'test levers need --dev')
  t.is(run(['--feature-flags', '{}']).refusal, 'test levers need --dev')
  t.is(run(['--runtime-config', '{}']).refusal, 'test levers need --dev')

  const { bootstrap } = run(['--dev', '--dht-bootstrap', '127.0.0.1:1, 127.0.0.1:2',
    '--feature-flags', '{"topicRefs":true}', '--runtime-config', '{"downloadFolder":"/d","peerReadTimeoutMs":5}'])
  t.alike(bootstrap.dhtBootstrap, ['127.0.0.1:1', '127.0.0.1:2'])
  t.alike(bootstrap.featureFlags, { topicRefs: true })
  t.is(bootstrap.downloadFolder, '/d')
  t.is(bootstrap.peerReadTimeoutMs, 5)
})

test('a runtime-config override cannot carry the store or a secret', (t) => {
  for (const key of ['storage', 'identityKEK', 'relaySeed', 'type']) {
    const { refusal } = run(['--dev', '--runtime-config', JSON.stringify({ [key]: 'x' })])
    t.is(refusal, `--runtime-config may not set ${key}`, key)
  }
  t.is(run(['--dev', '--runtime-config', '[1]']).refusal, '--runtime-config is not a JSON object')
  t.is(run(['--dev', '--feature-flags', 'nope']).refusal, '--feature-flags is not JSON')
})

test('an unknown flag, a positional or a flag without its value is refused with a reason', (t) => {
  t.is(run(['--bogus']).refusal, 'unknown_flag: bogus')
  t.is(run(['extra']).refusal, 'unknown_arg: extra')
  t.is(run(['--storage']).refusal, 'invalid_flag: storage')
  t.is(run(['--help']).refusal, 'help')
})
