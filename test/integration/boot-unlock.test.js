import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { bootDurable } from '../../src/worker/boot.js'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { getProfileKey } from '../../src/shared/spaces/profile.js'
import { randomKEK } from '../../src/shared/core/identity-envelope.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { tmpDir } from '../helpers/bare-tmp.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

// order:2, after every tier closes at order:1: removing a store RocksDB still holds breaks its close.
function peerConfig(t, extra = {}) {
  const home = tmpDir('boot-unlock')
  const storage = path.join(home, 'app-storage')
  const downloads = tmpDir('boot-unlock-dl')
  t.teardown(() => {
    for (const dir of [home, downloads]) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }, { order: 2 })
  fs.mkdirSync(storage, { recursive: true })
  const config = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads, ...extra }
  setRuntimeConfig(config)
  setDownloadFolder(downloads)
  return { home, config }
}

async function bootOnce(t, config) {
  const tier = await bootDurable(config, { ipc: createFakeIpc().ipc, log: quiet })
  t.teardown(() => tier.close(), { order: 1 })
  return tier
}

test('REGRESSION (P2.2c: a bootstrap without a KEK booted with no identity)', async (t) => {
  const { config } = peerConfig(t)
  let tiers = 0
  try {
    const leaked = await bootDurable(config, { ipc: createFakeIpc().ipc, log: quiet, onTier: () => { tiers++ } })
    await leaked.close()
    t.fail('booted without an unlock key')
  } catch (err) {
    t.is(err.code, 'IDENTITY_NO_KEK')
  }
  t.is(tiers, 0, 'refused before any resource started')

  const tier = await bootDurable({ ...config, identityKEK: b4a.toString(randomKEK(), 'hex') }, { ipc: createFakeIpc().ipc, log: quiet })
  t.pass('the same storage opens with a KEK: nothing was left holding the store lock')
  await tier.close()
})

test('a boot with a KEK seals identity.enc under os-keychain and reopens the same identity', async (t) => {
  const identityKEK = b4a.toString(randomKEK(), 'hex')
  const { home, config } = peerConfig(t, { identityKEK })

  const first = await bootDurable(config, { ipc: createFakeIpc().ipc, log: quiet })
  const profileKey = b4a.from(getProfileKey())
  await first.close()

  const env = JSON.parse(b4a.toString(fs.readFileSync(path.join(home, 'identity.enc'))))
  t.is(env.provider, 'os-keychain', 'the envelope names the provider that sealed it')

  await bootOnce(t, config)
  t.alike(getProfileKey(), profileKey, 'the reboot unlocks the same identity')
})
