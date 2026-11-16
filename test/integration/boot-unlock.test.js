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
import { registerBackupRestore } from '../../src/worker/ipc/backup-restore.js'
import { createKeyWait } from '../../src/worker/key-wait.js'
import { createPassphraseThrottle } from '../../src/shared/core/identity-recovery.js'
import { applyPendingIdentityChange, requestSetAside } from '../../src/shared/core/identity-adopt.js'
import { TRUST } from '../../src/shared/contract/ipc-frames.js'
import { sayHello } from '../helpers/ipc-hello.js'
import { waitFor } from '../helpers/bare-poll.js'
import { capture } from '../helpers/capture-console.js'
import { setVerbose } from '../helpers/runtime-verbose.js'

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

// The entry never boots without a key (it waits for one, below); the data layer still refuses one
// it is handed without a KEK, so no caller can open a store with no identity.
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

// A worker that has not been handed its key, spawned or headless: the router is live with the
// recovery set and identity:unlock, and a client hands over the key. Wired as the entry wires it —
// every opening puts a pending identity change in place and then boots the real root, without a
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
  const opened = []
  const keyWait = createKeyWait({
    open: async ({ kek, relaySeed }) => {
      opened.push(kek)
      await applyPendingIdentityChange(config.storage)
      const root = await boot({ ...config, identityKEK: kek, relaySeed: relaySeed ?? undefined }, { ipc: createFakeIpc().ipc, log, swarm: false, memberRegistry: offlineMemberRegistry })
      t.teardown(() => root.close(), { order: 1 })
      return root
    },
  })
  const deps = { storagePath: config.storage, identityKEK: () => keyWait.key?.kek, log, lockedBy: () => keyWait.code, recover: keyWait.recover, openRecovery: createPassphraseThrottle() }
  registerIdentity(ipc, deps)
  registerBackupRestore(ipc, deps)
  registerIdentityUnlock(ipc, { unlock: keyWait.unlock })
  ipc.start()
  const host = clientPipe()
  ipc.attach(host, { trust: TRUST.HOST })
  sayHello(host)
  const peer = clientPipe()
  ipc.attach(peer)
  sayHello(peer)
  return { host, peer, keyWait, opened }
}

const kekHex = () => b4a.toString(randomKEK(), 'hex')

test('a worker without a key waits, says so, and recovers nothing while it does', async (t) => {
  const { config } = peerConfig(t)
  const { host, opened } = waitingWorker(t, config)
  t.alike((await host.request('identity:status')).data, { locked: true, code: 'IDENTITY_AWAITING_KEY', restore: null })
  t.is((await host.request('identity:set-aside')).code, 'NOT_AUTHORIZED', 'nothing is set aside: the identity was never tried')
  t.is((await host.request('identity:unlock-from-backup', { folder: '/nowhere', passphrase: 'x' })).code, 'NOT_AUTHORIZED')
  t.is((await host.request('backup:peek', { folder: '/nowhere' })).code, 'NOT_AUTHORIZED', 'and no backup is restored over it')
  t.ok(fs.existsSync(config.storage), 'the store is where it was')
  t.is(opened.length, 0, 'and nothing was booted without a key')
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

// A spawned worker's first key comes the same way, so a wrong one locks it with the real code and
// the key stays held: everything the locked screen offers is served, and a retry opens in place.
async function establishedIdentity(t) {
  const kek = kekHex()
  const { home, config } = peerConfig(t)
  const first = await bootDurable({ ...config, identityKEK: kek }, { ipc: createFakeIpc().ipc, log: quiet })
  const profileKey = b4a.from(getProfileKey())
  await first.close()
  return { kek, home, config, profileKey }
}

test('a wrong key locks the worker with its code, and a retry with the right one opens in place', async (t) => {
  const { kek, config, profileKey } = await establishedIdentity(t)
  const { host, keyWait } = waitingWorker(t, config)
  const wrong = kekHex()
  t.is((await host.request('identity:unlock', { kek: wrong })).code, 'IDENTITY_UNLOCK_FAILED')
  t.alike((await host.request('identity:status')).data, { locked: true, code: 'IDENTITY_UNLOCK_FAILED', restore: null }, 'locked, and says why')
  t.is(keyWait.key.kek, wrong, 'the key it was handed is held to seal a recovery under')
  t.is((await host.request('identity:unlock', { kek: 'AB'.repeat(32) })).code, 'INVALID_ARGUMENT', 'uppercase is not the form a host sends')
  t.is((await host.request('identity:unlock', { kek: kekHex() })).code, 'IDENTITY_UNLOCK_FAILED', 'another wrong key locks again')
  t.alike((await host.request('identity:unlock', { kek })).data, { ok: true }, 'the right key, no restart')
  await keyWait.booted
  t.alike(getProfileKey(), profileKey, 'the same identity')
  t.alike((await host.request('identity:status')).data, { locked: false, code: null, restore: null })
  t.is((await host.request('identity:unlock', { kek })).code, 'NOT_AUTHORIZED', 'and an open worker takes no key')
})

test('a locked worker serves the recovery actions a waiting one refuses', async (t) => {
  const { config } = await establishedIdentity(t)
  const { host } = waitingWorker(t, config)
  await host.request('identity:unlock', { kek: kekHex() })
  const peek = await host.request('backup:peek', { folder: path.join(config.storage, 'no-such-folder') })
  t.is(peek.code, 'BACKUP_TARGET_OFFLINE', 'a backup is looked for, not refused')
  const missing = await host.request('identity:unlock-from-backup', { folder: tmpDir('boot-unlock-empty'), passphrase: 'x' })
  t.is(missing.code, 'BACKUP_TARGET_OFFLINE', 'an unlock from a backup is tried, not refused')
  t.is((await host.request('identity:status')).data.code, 'IDENTITY_UNLOCK_FAILED', 'and a failed one leaves the lock as it was')
})

test('setting a locked identity aside opens a new one in place, sealed under the held key', async (t) => {
  const { home, config, profileKey } = await establishedIdentity(t)
  const { host, keyWait, opened } = waitingWorker(t, config)
  const held = kekHex()
  await host.request('identity:unlock', { kek: held })
  const { folder } = (await host.request('identity:set-aside')).data
  t.is(path.dirname(folder), home, 'the locked data is beside the store')
  t.ok(fs.existsSync(path.join(folder, 'identity.enc')), 'with its envelope')
  await keyWait.booted
  t.alike(opened, [held, held], 'opened again, with the key the failed attempt handed over')
  t.not(b4a.toString(getProfileKey(), 'hex'), b4a.toString(profileKey, 'hex'), 'a new identity')
  t.alike((await host.request('identity:status')).data, { locked: false, code: null, restore: null }, 'open before the reply')
  t.is((await host.request('identity:set-aside')).code, 'NOT_AUTHORIZED', 'an open identity is not set aside')
})

test('a staged identity change is put in place before the open, not left for a restart', async (t) => {
  const { home, config } = await establishedIdentity(t)
  requestSetAside(config.storage)
  const { host, keyWait } = waitingWorker(t, config)
  t.ok(fs.existsSync(path.join(home, 'identity.enc')), 'nothing moves while the worker waits')
  t.alike((await host.request('identity:unlock', { kek: kekHex() })).data, { ok: true }, 'a key that could not open the old identity opens the fresh one')
  await keyWait.booted
  t.is(fs.readdirSync(home).filter((n) => n.startsWith('app-storage.locked-')).length, 1, 'the set-aside ran first')
})

test('only the host may hand over the key', async (t) => {
  const { config } = peerConfig(t)
  const { host, peer } = waitingWorker(t, config)
  const refused = await peer.request('identity:unlock', { kek: kekHex() })
  t.is(refused.code, 'NOT_AUTHORIZED')
  t.is((await host.request('identity:status')).data.code, 'IDENTITY_AWAITING_KEY', 'and nothing booted')
})

// Every path a key travels, at the most verbose level, with the worker's own logger narrating the
// boot: a frame that is not JSON, keys of the wrong length, a wrong key, a retry carrying a relay
// seed, and a recovery that opens the identity under the held key. The key never appears in any
// form a log line could carry it.
test('no log line carries the key, on any unlock or recovery path', async (t) => {
  const { config } = await establishedIdentity(t)
  setVerbose(t, true)
  const lines = capture(t, ['log', 'warn', 'error'])
  const { host, keyWait } = waitingWorker(t, config, { log: createLogger('worklet') })

  const wrong = kekHex()
  const retry = kekHex()
  const seed = kekHex()
  host.sendRaw(wrong + '\n')
  host.sendRaw('{"id":"m1","type":"identity:unlock","kek":"' + wrong + '"x\n')
  await host.request('identity:unlock', { kek: wrong.slice(2) })
  await host.request('identity:unlock', { kek: wrong + 'ff' })
  t.is((await host.request('identity:unlock', { kek: wrong })).code, 'IDENTITY_UNLOCK_FAILED')
  t.is((await host.request('identity:unlock', { kek: retry, relaySeed: seed })).code, 'IDENTITY_UNLOCK_FAILED')
  t.ok((await host.request('identity:set-aside')).data.folder, 'the recovery opened the identity in place')
  await keyWait.booted

  const logged = [...lines.log, ...lines.warn, ...lines.error].join('\n')
  t.ok(logged.includes('identity:unlock'), 'the requests themselves were logged')
  t.ok(logged.includes('identity:set-aside'), 'and the recovery')
  for (const key of [wrong, retry, seed]) {
    const raw = b4a.from(key, 'hex')
    for (const [form, text] of [['hex', key], ['base64', b4a.toString(raw, 'base64')], ['bytes', b4a.toString(raw, 'latin1')]]) {
      t.absent(logged.includes(text.slice(0, 12)), `no ${form} form of a key`)
    }
  }
})

test('REGRESSION (FIX-UNLOCK-2): a connection with identity:unlock in flight survives a sweep past keepalive and grace, and is reaped once it is idle', async (t) => {
  const ipc = createIPC(null)
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  registerIdentityUnlock(ipc, { unlock: () => gate })
  ipc.start()
  const host = clientPipe()
  ipc.attach(host, { trust: TRUST.HOST })
  sayHello(host)
  const asked = host.request('identity:unlock', { kek: kekHex() })
  await waitFor(() => ipc.inFlightCount() === 1, 5000, { label: 'unlock in flight' })

  ipc.sweepLiveness({ keepaliveMs: 0, graceMs: 0 })
  ipc.sweepLiveness({ keepaliveMs: 0, graceMs: 0 })
  t.is(ipc.clientCount(), 1, 'the host that asked for the boot is still attached')
  t.is(ipc.inFlightCount(), 1, 'and its unlock is still running')

  release()
  t.alike((await asked).data, { ok: true })
  ipc.sweepLiveness({ keepaliveMs: 0, graceMs: 0 })
  ipc.sweepLiveness({ keepaliveMs: 0, graceMs: 0 })
  t.is(ipc.clientCount(), 0, 'with nothing in flight it is swept like any quiet client')
})
