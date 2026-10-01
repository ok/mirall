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

// Boot a named identity under KEK-A, take its recovery key, and stop it.
async function establish(t, bootstrap, home, displayName) {
  const identityKEK = kekHex()
  const peer = await launchPeer(t, { bootstrap, displayName, ...home, flags: { identityKEK } })
  const personKey = (await peer.request('profile:get')).personKey
  const { content } = await peer.request('identity:export-recovery', { passphrase: PASS })
  await stop(peer)
  return { personKey, content, identityKEK }
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
  t.is(await codeOf(locked.request('identity:export-recovery', { passphrase: PASS })), 'IDENTITY_UNLOCK_FAILED', 'nothing to export')
  t.is(await codeOf(locked.request('identity:set-aside')), null, 'a locked worker accepts a set-aside')
})

test('a recovery key restores the identity through a locked worker', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const alice = await establish(t, bootstrap, home, 'Alice')
  const newKEK = kekHex()

  const locked = await launchLocked(t, bootstrap, home, newKEK)
  t.is(await codeOf(locked.request('identity:import-recovery', { content: alice.content, passphrase: 'not the passphrase', replace: false })),
    'WRONG_PASSPHRASE')
  t.alike(await locked.request('identity:status'), { locked: true, code: 'IDENTITY_UNLOCK_FAILED', restore: null }, 'still locked')
  t.alike(await locked.request('identity:import-recovery', { content: alice.content, passphrase: PASS, replace: false }), { ok: true },
    'the store holds this identity, so no confirmation is needed')
  await stop(locked)

  // Held even over its own data, which may be older than what peers hold; with no co-member anywhere
  // nobody else can hold it, so the hold lifts at once and the next boot is a normal one.
  const holding = await launchPeer(t, { bootstrap, displayName: 'Alice', ...home, flags: { identityKEK: newKEK }, setProfile: false })
  await holding.until('identity:status', {}, (s) => s.restore?.released === true, { ms: 30000, every: 500 })
  await stop(holding)
  const restored = await launchPeer(t, { bootstrap, displayName: 'Alice', ...home, flags: { identityKEK: newKEK }, setProfile: false })
  t.alike(await restored.request('identity:status'), { locked: false, code: null, restore: null })
  const profile = await restored.request('profile:get')
  t.is(profile.personKey, alice.personKey, 'the same network identity')
  t.is(profile.displayName, 'Alice', 'over the same data')
})

test('a recovery key for another identity is refused unless the user replaces', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  await establish(t, bootstrap, home, 'Alice')
  const bob = await establish(t, bootstrap, peerHome(t), 'Bob')
  const newKEK = kekHex()

  const locked = await launchLocked(t, bootstrap, home, newKEK)
  t.alike(await locked.request('identity:import-recovery', { content: bob.content, passphrase: PASS, replace: false }),
    { ok: false, mismatch: true })
  t.ok(fs.existsSync(path.join(home.root, 'identity.enc')), 'the envelope is untouched')
  t.alike(await locked.request('identity:import-recovery', { content: bob.content, passphrase: PASS, replace: true }), { ok: true })
  await stop(locked)

  const setAside = fs.readdirSync(home.root).filter((n) => n.startsWith('app-storage.locked-'))
  t.is(setAside.length, 1, "Alice's data was set aside, not left for Bob's key to fail on")
  const asBob = await launchPeer(t, { bootstrap, displayName: 'Bob here', ...home, flags: { identityKEK: newKEK }, setProfile: false })
  const status = await asBob.request('identity:status')
  t.is(status.locked, false, 'the next boot opens')
  t.is(status.restore?.verdict, 'no-holder', "and holds Bob's profile until a peer holding it is reached")
  t.is(await codeOf(asBob.request('profile:set', { displayName: 'Bob here' })), 'SESSION_NOT_WRITABLE', 'nothing writes it before then')

  t.alike(await asBob.request('identity:set-aside'), { folder: null }, 'a restore can still be set aside')
  await stop(asBob)
  const fresh = await launchPeer(t, { bootstrap, displayName: 'Someone new', ...home, flags: { identityKEK: newKEK } })
  t.alike(await fresh.request('identity:status'), { locked: false, code: null, restore: null })
  t.not((await fresh.request('profile:get')).personKey, bob.personKey, 'a new identity')
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

test('a running identity never adopts a recovery key: that would fork it', { timeout: scaled(120000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const home = peerHome(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice', ...home, flags: { identityKEK: kekHex() } })
  const { content } = await peer.request('identity:export-recovery', { passphrase: PASS })
  t.is(await codeOf(peer.request('identity:import-recovery', { content, passphrase: PASS, replace: false })), 'NOT_AUTHORIZED')
  t.is(await codeOf(peer.request('identity:set-aside')), 'NOT_AUTHORIZED')
})
