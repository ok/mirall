import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const PASS = 'a long enough passphrase'

// A peer in its own <root>/app-storage, like production, so identity.enc sits in a directory no
// other peer shares.
function peerHome(t) {
  const root = mkTmpDir(t)
  return { root, storage: path.join(root, 'app-storage'), downloads: mkTmpDir(t) }
}

async function stop(peer) {
  const pid = peer.sidecar?._process?.pid
  peer.kill()
  if (pid) await waitForWorkerExit(pid, 5000)
}

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

// Boot a named identity under KEK-A, back it up — its key and one snapshot — and stop it.
async function establish(t, bootstrap, home, displayName) {
  const identityKEK = kekHex()
  const backupFolder = mkTmpDir(t)
  const peer = await launchPeer(t, { bootstrap, displayName, ...home, flags: { identityKEK, backupFolder } })
  const personKey = (await peer.request('profile:get')).personKey
  await peer.request('backup:run', {})
  await peer.request('backup:new-key', { passphrase: PASS })
  const { lastSnapshot } = await peer.request('backup:run', {})
  await stop(peer)
  return { personKey, backupFolder, lastSnapshot, identityKEK }
}

// The same storage handed a key that cannot open it, as after a keychain reset or a machine move:
// the worker waits, the key is sent over the peer's own connection, and the worker locks.
async function launchLocked(t, bootstrap, home, identityKEK = kekHex()) {
  const peer = await launchPeer(t, { bootstrap, displayName: 'Locked', ...home, flags: { identityKEK }, unlock: false, setProfile: false })
  t.is(await codeOf(peer.request('identity:unlock', { kek: identityKEK })), 'IDENTITY_UNLOCK_FAILED', 'the key cannot open it')
  return peer
}

// A recovery answers once the identity is open, and every client is greeted again as it goes live.
async function recoverInPlace(peer, type, args = {}) {
  const live = peer.waitFor('event:worker-ready', () => true, 60000)
  const reply = await peer.request(type, args)
  await live
  return reply
}

function printedNoKey(t, peer, keys) {
  const printed = peer.readStderr() + peer.readStdout()
  for (const key of keys) t.absent(printed.includes(key.slice(0, 12)), 'no key in what the worker printed')
}

test('REGRESSION (MIR-30: a KEK that cannot open identity.enc crash-looped the worker)', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  await establish(t, bootstrap, home, 'Alice')

  const wrong = kekHex()
  const locked = await launchLocked(t, bootstrap, home, wrong)
  t.alike(await locked.request('identity:status'), { locked: true, code: 'IDENTITY_UNLOCK_FAILED', restore: null }, 'the worker is up and says why')
  t.ok((await locked.request('ping')).pong, 'and answers')
  t.is(await codeOf(locked.request('profile:get')), 'NOT_FOUND', 'the data layer is not served while locked')
  const retry = kekHex()
  t.is(await codeOf(locked.request('identity:unlock', { kek: retry })), 'IDENTITY_UNLOCK_FAILED', 'a retry with another wrong key locks again')
  t.is((await locked.request('identity:status')).code, 'IDENTITY_UNLOCK_FAILED')
  t.ok((await recoverInPlace(locked, 'identity:set-aside')).folder, 'a locked worker accepts a set-aside')
  printedNoKey(t, locked, [wrong, retry])
})

test('the right key on a retry opens the locked worker in place', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const alice = await establish(t, bootstrap, home, 'Alice')

  const locked = await launchLocked(t, bootstrap, home)
  const live = locked.waitFor('event:worker-ready', () => true, 60000)
  t.alike(await locked.request('identity:unlock', { kek: alice.identityKEK }), { ok: true })
  await live
  t.alike(await locked.request('identity:status'), { locked: false, code: null, restore: null })
  t.is((await locked.request('profile:get')).personKey, alice.personKey, 'the same identity, no restart')
  t.is(await codeOf(locked.request('identity:unlock', { kek: alice.identityKEK })), 'NOT_AUTHORIZED', 'an open worker takes no key')
})

test('the backup\'s key unlocks the identity in place through a locked worker', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const alice = await establish(t, bootstrap, home, 'Alice')

  const locked = await launchLocked(t, bootstrap, home)
  t.is(await codeOf(locked.request('identity:unlock-from-backup', { folder: alice.backupFolder, passphrase: 'not the passphrase' })),
    'WRONG_PASSPHRASE')
  t.alike(await locked.request('identity:status'), { locked: true, code: 'IDENTITY_UNLOCK_FAILED', restore: null }, 'still locked')
  t.alike(await recoverInPlace(locked, 'identity:unlock-from-backup', { folder: alice.backupFolder, passphrase: PASS }), { unlocked: true },
    'the store holds this identity, so its own data opens in place')

  // Held even over its own data, which may be older than what peers hold; with no co-member anywhere
  // nobody else can hold it, so the hold lifts at once.
  const status = await locked.request('identity:status')
  t.is(status.locked, false, 'open without a restart')
  await locked.until('identity:status', {}, (s) => s.restore?.profile?.released === true, { ms: 30000, every: 500 })
  const profile = await locked.request('profile:get')
  t.is(profile.personKey, alice.personKey, 'the same network identity')
  t.is(profile.displayName, 'Alice', 'over the same data')
})

test('another identity\'s backup does not unlock the locked data; restoring it sets that data aside', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  await establish(t, bootstrap, home, 'Alice')
  const bob = await establish(t, bootstrap, peerHome(t), 'Bob')

  const locked = await launchLocked(t, bootstrap, home)
  t.alike(await locked.request('identity:unlock-from-backup', { folder: bob.backupFolder, passphrase: PASS }), { unlocked: false })
  t.ok(fs.existsSync(path.join(home.root, 'identity.enc')), 'the envelope is untouched')
  t.is((await locked.request('identity:status')).code, 'IDENTITY_UNLOCK_FAILED', 'and the worker is still locked')
  const { snapshots } = await locked.request('backup:inspect', { folder: bob.backupFolder, passphrase: PASS })
  t.is(snapshots[0].name, bob.lastSnapshot)
  const restored = await recoverInPlace(locked, 'backup:restore', { folder: bob.backupFolder, snapshot: bob.lastSnapshot, passphrase: PASS })
  t.is(restored.ok, true)

  const setAside = fs.readdirSync(home.root).filter((n) => n.startsWith('app-storage.locked-'))
  t.is(setAside.length, 1, "Alice's data was set aside, not overwritten")
  t.absent(fs.existsSync(path.join(home.root, 'app-storage.restoring')), 'and the staged restore was put in place')
  t.is((await locked.request('identity:status')).locked, false, 'it opens without a restart')
  t.is((await locked.request('profile:get')).personKey, bob.personKey, "as Bob, from Bob's backup")
})

test('starting fresh sets the locked data aside and opens a new identity in place', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const alice = await establish(t, bootstrap, home, 'Alice')

  const locked = await launchLocked(t, bootstrap, home)
  const { folder } = await recoverInPlace(locked, 'identity:set-aside')
  t.is(path.dirname(folder), home.root, 'beside the store')
  t.ok(fs.existsSync(path.join(folder, 'identity.enc')), 'the locked envelope moved with the data')
  t.ok(fs.existsSync(path.join(folder, 'CORESTORE')), 'and so did the store')

  t.alike(await locked.request('identity:status'), { locked: false, code: null, restore: null }, 'open without a restart')
  await locked.request('profile:set', { displayName: 'Alice again', avatar: null })
  t.not((await locked.request('profile:get')).personKey, alice.personKey, 'a new identity')
})

test('a running identity is never unlocked with a backup: that would fork it', { timeout: scaled(120000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice', ...home, flags: { identityKEK: kekHex() } })
  t.is(await codeOf(peer.request('identity:unlock-from-backup', { folder: mkTmpDir(t), passphrase: PASS })), 'NOT_AUTHORIZED')
  t.is(await codeOf(peer.request('identity:set-aside')), 'NOT_AUTHORIZED')
})

// The one-release seam: a key on the spawn frame still opens the identity, and a wrong one still
// locks it with its code. A headless worker has no spawn frame, so it is spawned here.
test('the one-release seam: a key on the spawn frame still boots, and a wrong one still locks', { timeout: scaled(150000) }, async (t) => {
  const transport = process.env.MIRALL_TEST_IPC_TRANSPORT === 'headless' ? 'pipe' : undefined
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const identityKEK = kekHex()
  const first = await launchPeer(t, { transport, bootstrap, displayName: 'Alice', ...home, flags: { identityKEK }, keyOnBootstrap: true })
  t.alike(await first.request('identity:status'), { locked: false, code: null, restore: null }, 'opened from the frame')
  const personKey = (await first.request('profile:get')).personKey
  await stop(first)

  const wrong = await launchPeer(t, { transport, bootstrap, ...home, flags: { identityKEK: kekHex() }, keyOnBootstrap: true, setProfile: false })
  t.alike(await wrong.request('identity:status'), { locked: true, code: 'IDENTITY_UNLOCK_FAILED', restore: null }, 'a wrong one locks, and says why')
  const live = wrong.waitFor('event:worker-ready', () => true, 60000)
  t.alike(await wrong.request('identity:unlock', { kek: identityKEK }), { ok: true }, 'and the right one opens it over the connection')
  await live
  t.is((await wrong.request('profile:get')).personKey, personKey)
})
