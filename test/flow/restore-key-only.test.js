import test from 'brittle'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const PASS = 'a long enough passphrase'
const kekHex = () => crypto.randomBytes(32).toString('hex')
const DWELL = { restoreReleaseDwellMs: 1000 }

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

const sawFork = (...peers) => peers.some((peer) => peer.readStdout().includes('conflict detected'))

// The original device is gone: two live installs of one identity are the multi-device case, not a
// restore.
test('a recovery key on an empty device catches its profile up from a co-member before writing it', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const alice = await launchPeer(t, { bootstrap, displayName: 'Alice', ...peerHome(t), flags: { identityKEK: kekHex() } })
  const carol = await launchPeer(t, { bootstrap, displayName: 'Carol', ...peerHome(t), flags: { identityKEK: kekHex(), ...DWELL } })
  const spaceId = await connectInSpace(t, alice, carol)
  const aliceKey = (await alice.request('profile:get')).personKey
  const { content } = await alice.request('identity:export-recovery', { passphrase: PASS })
  await stop(alice)

  const home = peerHome(t)
  const kek = kekHex()
  const launch = () => launchPeer(t, { bootstrap, ...home, flags: { identityKEK: kek, ...DWELL }, setProfile: false })

  const onboarding = await launch()
  t.alike(await onboarding.request('identity:import-recovery', { content, passphrase: PASS, replace: false }), { ok: true },
    'an unused identity takes the key')
  await stop(onboarding)

  const restoring = await launch()
  const held = await restoring.request('identity:status')
  t.is(held.restore?.profile?.verdict, 'no-holder', 'restore mode, waiting for someone who holds the profile')
  t.is(await codeOf(restoring.request('profile:set', { displayName: 'Too early' })), 'RESTORE_HELD',
    'nothing writes the profile before it has caught up, and the refusal says why')
  t.is(await codeOf(restoring.request('space:create', { name: 'Too early' })), 'RESTORE_HELD', 'nor creates a space in it')

  const inviteCode = await carol.request('space:invite', { spaceId, autoAdmit: true, expiresInMs: 2 * 60 * 60 * 1000 })
  await restoring.request('space:join', { inviteCode })
  const released = await restoring.until('identity:status', {}, (s) => s.restore?.profile?.released === true, { ms: 150000, every: 500 })
  t.ok(released.restore.profile.length > 0, 'the profile arrived from Carol')
  await stop(restoring)

  const back = await launch()
  t.alike(await back.request('identity:status'), { locked: false, code: null, restore: null }, 'the next boot is a normal one')
  const profile = await back.request('profile:get')
  t.is(profile.personKey, aliceKey, 'the same network identity')
  t.is(profile.displayName, 'Alice', 'with the profile peers held')

  await back.request('profile:set', { displayName: 'Alice, restored' })
  await carol.until('space:members', { spaceId },
    (roster) => Array.isArray(roster) && roster.some((m) => m.publicKey === aliceKey && m.displayName === 'Alice, restored'),
    { ms: 120000, every: 1000 })
  t.absent(sawFork(restoring, back, carol), 'no peer saw two histories of the profile')
})
