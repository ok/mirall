import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { boot, bootDurable } from '../../src/worker/boot.js'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { getProfileKey } from '../../src/shared/spaces/profile.js'
import { randomKEK } from '../../src/shared/core/identity-envelope.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { offlineMemberRegistry } from '../helpers/store.js'
import EventEmitter from 'bare-events'
import { createIPC } from '../../src/shared/core/ipc.js'
import { createLogger } from '../../src/shared/core/logger.js'
import { registerIdentity } from '../../src/worker/ipc/identity.js'
import { registerIdentityUnlock } from '../../src/worker/ipc/identity-unlock.js'
import { createKeyWait } from '../../src/worker/key-wait.js'
import { createPassphraseThrottle } from '../../src/shared/core/identity-recovery.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { TRUST } from '../../src/shared/contract/ipc-frames.js'
import { sayHello } from '../helpers/ipc-hello.js'
import { waitFor } from '../helpers/bare-poll.js'
import { capture } from '../helpers/capture-console.js'

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

// A worker started without a host: the router is live with the recovery set and identity:unlock,
// and a client hands over the key. Wired as the entry wires it, booting the real root without a
// swarm; the flow suite runs the entry itself.
function clientPipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(String(s)); return true }
  ee.send = (obj) => ee.emit('data', b4a.from(JSON.stringify(obj) + '\n'))
  ee.sendRaw = (str) => ee.emit('data', b4a.from(str))
  ee.response = (id) => ee.written.flatMap((l) => l.split('\n')).filter(Boolean).map((l) => JSON.parse(l))
    .find((f) => f.type === 'response' && f.id === id)
  let next = 0
  ee.request = async (type, args = {}) => {
    const id = 'r' + (next++)
    ee.send({ id, type, ...args })
    await waitFor(() => ee.response(id), 60000, { label: type })
    return ee.response(id)
  }
  return ee
}

function waitingWorker(t, config, { log = quiet } = {}) {
  const ipc = createIPC(null)
  let lockedBy = CODES.IDENTITY_AWAITING_KEY
  const keyWait = createKeyWait({
    awaiting: true,
    boot: async ({ kek }) => {
      const root = await boot({ ...config, identityKEK: kek }, { ipc: createFakeIpc().ipc, log, swarm: false, memberRegistry: offlineMemberRegistry })
      t.teardown(() => root.close(), { order: 1 })
      return root
    },
  })
  keyWait.booted.then(() => { lockedBy = null }, () => {})
  registerIdentity(ipc, { storagePath: config.storage, identityKEK: () => null, log, lockedBy: () => lockedBy, openRecovery: createPassphraseThrottle() })
  registerIdentityUnlock(ipc, { unlock: keyWait.unlock })
  ipc.start()
  const host = clientPipe()
  ipc.attach(host, { trust: TRUST.HOST })
  sayHello(host)
  const peer = clientPipe()
  ipc.attach(peer)
  sayHello(peer)
  return { host, peer, keyWait }
}

const kekHex = () => b4a.toString(randomKEK(), 'hex')

test('a worker without a key waits, says so, and recovers nothing while it does', async (t) => {
  const { config } = peerConfig(t)
  const { host } = waitingWorker(t, config)
  t.alike((await host.request('identity:status')).data, { locked: true, code: 'IDENTITY_AWAITING_KEY', restore: null })
  t.is((await host.request('identity:set-aside')).code, 'NOT_AUTHORIZED', 'nothing is set aside: the identity was never tried')
  t.is((await host.request('identity:unlock-from-backup', { folder: '/nowhere', passphrase: 'x' })).code, 'NOT_AUTHORIZED')
  t.ok(fs.existsSync(config.storage), 'the store is where it was')
})

test('a good key boots the worker in place, and a second unlock is refused', async (t) => {
  const { config } = peerConfig(t)
  const { host, keyWait } = waitingWorker(t, config)
  t.alike((await host.request('identity:unlock', { kek: kekHex() })).data, { ok: true })
  await keyWait.booted
  t.ok(getProfileKey(), 'the data layer is up under the identity the key sealed')
  t.alike((await host.request('identity:status')).data, { locked: false, code: null, restore: null })
  const again = await host.request('identity:unlock', { kek: kekHex() })
  t.is(again.code, 'NOT_AUTHORIZED', 'never a second boot')
})

test('a wrong key is refused and the worker keeps waiting for the right one', async (t) => {
  const kek = kekHex()
  const { config } = peerConfig(t)
  const first = await bootDurable({ ...config, identityKEK: kek }, { ipc: createFakeIpc().ipc, log: quiet })
  const profileKey = b4a.from(getProfileKey())
  await first.close()

  const { host, keyWait } = waitingWorker(t, config)
  const wrong = await host.request('identity:unlock', { kek: kekHex() })
  t.is(wrong.code, 'IDENTITY_UNLOCK_FAILED')
  t.is((await host.request('identity:status')).data.code, 'IDENTITY_AWAITING_KEY', 'still waiting')
  t.is((await host.request('identity:unlock', { kek: 'AB'.repeat(32) })).code, 'INVALID_ARGUMENT', 'uppercase is not the form a host sends')
  t.alike((await host.request('identity:unlock', { kek })).data, { ok: true }, 'the right key, no restart')
  await keyWait.booted
  t.alike(getProfileKey(), profileKey, 'the same identity')
})

test('only the host may hand over the key', async (t) => {
  const { config } = peerConfig(t)
  const { host, peer } = waitingWorker(t, config)
  const refused = await peer.request('identity:unlock', { kek: kekHex() })
  t.is(refused.code, 'NOT_AUTHORIZED')
  t.is((await host.request('identity:status')).data.code, 'IDENTITY_AWAITING_KEY', 'and nothing booted')
})

// Every path a key travels, at the most verbose level, with the worker's own logger narrating the
// boot: the key never appears in any form a log line could carry it.
test('no log line carries the key, on any unlock path', async (t) => {
  const kek = kekHex()
  const { config } = peerConfig(t)
  const first = await bootDurable({ ...config, identityKEK: kek }, { ipc: createFakeIpc().ipc, log: quiet })
  await first.close()
  setRuntimeConfig({ ...config, verbose: true })
  const lines = capture(t, ['log', 'warn', 'error'])
  const { host, keyWait } = waitingWorker(t, config, { log: createLogger('worklet') })

  const wrong = kekHex()
  host.sendRaw(wrong + '\n')
  host.sendRaw('{"id":"m1","type":"identity:unlock","kek":"' + wrong + '"x\n')
  await host.request('identity:unlock', { kek: wrong.slice(2) })
  await host.request('identity:unlock', { kek: wrong + 'ff' })
  await host.request('identity:unlock', { kek: wrong })
  await host.request('identity:unlock', { kek, relaySeed: wrong })
  await keyWait.booted

  const logged = [...lines.log, ...lines.warn, ...lines.error].join('\n')
  t.ok(logged.includes('identity:unlock'), 'the requests themselves were logged')
  for (const key of [kek, wrong]) {
    const raw = b4a.from(key, 'hex')
    for (const [form, text] of [['hex', key], ['base64', b4a.toString(raw, 'base64')], ['bytes', b4a.toString(raw, 'latin1')]]) {
      t.absent(logged.includes(text.slice(0, 12)), `no ${form} form of a key`)
    }
  }
})
