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

// The same storage under a key that cannot open it, as after a keychain reset or a machine move.
function launchLocked(t, bootstrap, home, identityKEK = kekHex()) {
  return launchPeer(t, { bootstrap, displayName: 'Locked', ...home, flags: { identityKEK }, setProfile: false })
}

test('REGRESSION (MIR-30: a KEK that cannot open identity.enc crash-looped the worker)', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  await establish(t, bootstrap, home, 'Alice')

  const locked = await launchLocked(t, bootstrap, home)
  t.alike(await locked.request('identity:status'), { locked: true, code: 'IDENTITY_UNLOCK_FAILED', restore: null }, 'the worker is up and says why')
  t.ok((await locked.request('ping')).pong, 'and answers')
  t.is(await codeOf(locked.request('profile:get')), 'NOT_FOUND', 'the data layer is not served while locked')
  t.is(await codeOf(locked.request('identity:set-aside')), null, 'a locked worker accepts a set-aside')
})

test('the backup\'s key unlocks the identity in place through a locked worker', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const alice = await establish(t, bootstrap, home, 'Alice')
  const newKEK = kekHex()

  const locked = await launchLocked(t, bootstrap, home, newKEK)
  t.is(await codeOf(locked.request('identity:unlock-from-backup', { folder: alice.backupFolder, passphrase: 'not the passphrase' })),
    'WRONG_PASSPHRASE')
  t.alike(await locked.request('identity:status'), { locked: true, code: 'IDENTITY_UNLOCK_FAILED', restore: null }, 'still locked')
  t.alike(await locked.request('identity:unlock-from-backup', { folder: alice.backupFolder, passphrase: PASS }), { unlocked: true },
    'the store holds this identity, so its own data opens in place')
  await stop(locked)

  // Held even over its own data, which may be older than what peers hold; with no co-member anywhere
  // nobody else can hold it, so the hold lifts at once and the next boot is a normal one.
  const holding = await launchPeer(t, { bootstrap, displayName: 'Alice', ...home, flags: { identityKEK: newKEK }, setProfile: false })
  await holding.until('identity:status', {}, (s) => s.restore?.profile?.released === true, { ms: 30000, every: 500 })
  await stop(holding)
  const restored = await launchPeer(t, { bootstrap, displayName: 'Alice', ...home, flags: { identityKEK: newKEK }, setProfile: false })
  t.alike(await restored.request('identity:status'), { locked: false, code: null, restore: null })
  const profile = await restored.request('profile:get')
  t.is(profile.personKey, alice.personKey, 'the same network identity')
  t.is(profile.displayName, 'Alice', 'over the same data')
})

test('another identity\'s backup does not unlock the locked data; restoring it sets that data aside', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  await establish(t, bootstrap, home, 'Alice')
  const bob = await establish(t, bootstrap, peerHome(t), 'Bob')
  const newKEK = kekHex()

  const locked = await launchLocked(t, bootstrap, home, newKEK)
  t.alike(await locked.request('identity:unlock-from-backup', { folder: bob.backupFolder, passphrase: PASS }), { unlocked: false })
  t.ok(fs.existsSync(path.join(home.root, 'identity.enc')), 'the envelope is untouched')
  const { snapshots } = await locked.request('backup:inspect', { folder: bob.backupFolder, passphrase: PASS })
  t.is(snapshots[0].name, bob.lastSnapshot)
  t.is((await locked.request('backup:restore', { folder: bob.backupFolder, snapshot: bob.lastSnapshot, passphrase: PASS })).ok, true)
  await stop(locked)

  const asBob = await launchPeer(t, { bootstrap, displayName: 'Bob here', ...home, flags: { identityKEK: newKEK }, setProfile: false })
  const setAside = fs.readdirSync(home.root).filter((n) => n.startsWith('app-storage.locked-'))
  t.is(setAside.length, 1, "Alice's data was set aside, not overwritten")
  t.is((await asBob.request('identity:status')).locked, false, 'the next boot opens')
  t.is((await asBob.request('profile:get')).personKey, bob.personKey, "as Bob, from Bob's backup")
})

test('starting fresh sets the locked data aside and boots a new identity', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const alice = await establish(t, bootstrap, home, 'Alice')
  const newKEK = kekHex()

  const locked = await launchLocked(t, bootstrap, home, newKEK)
  const { folder } = await locked.request('identity:set-aside')
  await stop(locked)
  t.is(path.dirname(folder), home.root, 'beside the store')
  t.ok(fs.existsSync(path.join(folder, 'identity.enc')), 'the locked envelope moved with the data')
  t.ok(fs.existsSync(path.join(folder, 'CORESTORE')), 'and so did the store')

  const fresh = await launchPeer(t, { bootstrap, displayName: 'Alice again', ...home, flags: { identityKEK: newKEK } })
  t.alike(await fresh.request('identity:status'), { locked: false, code: null, restore: null })
  t.not((await fresh.request('profile:get')).personKey, alice.personKey, 'a new identity')
})

test('a running identity is never unlocked with a backup: that would fork it', { timeout: scaled(120000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice', ...home, flags: { identityKEK: kekHex() } })
  t.is(await codeOf(peer.request('identity:unlock-from-backup', { folder: mkTmpDir(t), passphrase: PASS })), 'NOT_AUTHORIZED')
  t.is(await codeOf(peer.request('identity:set-aside')), 'NOT_AUTHORIZED')
})
