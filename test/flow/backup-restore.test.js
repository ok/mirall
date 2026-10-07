import test from 'brittle'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace, waitForWorkerExit, waitForCatalogEntry } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, writeTmpFile } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const PASS = 'a long enough passphrase'
const kekHex = () => crypto.randomBytes(32).toString('hex')

function peerHome(t) {
  const root = mkTmpDir(t)
  return { root, storage: path.join(root, 'app-storage'), downloads: mkTmpDir(t) }
}

async function stop(peer) {
  const pid = peer.sidecar?._process?.pid
  peer.kill()
  if (pid) await waitForWorkerExit(pid, 5000)
}

const sawFork = (...peers) => peers.some((peer) => peer.readStdout().includes('conflict detected'))

async function share(t, peer, spaceId, fileName, seed) {
  const bytes = patternedBytes(4096, seed)
  await peer.request('files:add', { spaceId, filePath: writeTmpFile(bytes, t), fileName, fileSize: bytes.length })
}

// The original device is gone (its data folder wiped); the new one restores the last backup, which
// is behind what the co-member holds, and must catch up before it writes anything.
test('a device restored from a backup catches up from a co-member, then writes without forking', { timeout: scaled(420000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const backupFolder = mkTmpDir(t)
  const backupFlags = { backupFolder, restoreReleaseDwellMs: 1000 }
  const alice = await launchPeer(t, { bootstrap, displayName: 'Alice', ...peerHome(t), flags: { identityKEK: kekHex(), ...backupFlags } })
  const carol = await launchPeer(t, { bootstrap, displayName: 'Carol', ...peerHome(t), flags: { identityKEK: kekHex() } })
  const spaceId = await connectInSpace(t, alice, carol)
  const aliceKey = (await alice.request('profile:get')).personKey

  await share(t, alice, spaceId, 'before.bin', 1)
  await waitForCatalogEntry(carol, spaceId, '/before.bin', { ms: 120000 })

  await alice.request('backup:run', {})
  await alice.request('backup:new-key', { passphrase: PASS })
  const backedUp = await alice.request('backup:run', {})
  t.ok(backedUp.lastSnapshot, 'Alice backed up')

  // After the backup: a rename and a new file, which Carol replicates and the backup does not have.
  await alice.request('profile:set', { displayName: 'Alice, after the backup' })
  await share(t, alice, spaceId, 'after.bin', 2)
  await waitForCatalogEntry(carol, spaceId, '/after.bin', { ms: 120000 })
  await carol.until('space:members', { spaceId }, (r) => Array.isArray(r) && r.some((m) => m.publicKey === aliceKey && m.displayName === 'Alice, after the backup'), { ms: 120000, every: 1000 })
  await stop(alice)

  const home = peerHome(t)
  const kek = kekHex()
  const launch = () => launchPeer(t, { bootstrap, ...home, flags: { identityKEK: kek, ...backupFlags }, setProfile: false })

  const fresh = await launch()
  const { snapshots } = await fresh.request('backup:inspect', { folder: backupFolder, passphrase: PASS })
  t.is(snapshots[0].name, backedUp.lastSnapshot)
  t.is((await fresh.request('backup:restore', { folder: backupFolder, snapshot: snapshots[0].name, passphrase: PASS })).ok, true)
  await stop(fresh)

  const restoring = await launch()
  const status = await restoring.request('identity:status')
  t.ok(status.restore, 'the restored device starts in restore mode')
  t.is((await restoring.request('profile:get')).displayName, 'Alice', 'with the profile as it was backed up')
  await restoring.until('identity:status', {}, (s) => s.restore?.profile?.released === true, { ms: 180000, every: 500 })
  await stop(restoring)

  const back = await launch()
  t.alike(await back.request('identity:status'), { locked: false, code: null, restore: null })
  const profile = await back.request('profile:get')
  t.is(profile.personKey, aliceKey, 'the same identity')
  t.is(profile.displayName, 'Alice, after the backup', 'caught up past the backup from Carol')
  t.ok((await back.request('spaces:list')).some((s) => s.spaceId === spaceId), 'the space came back with the backup')

  await back.request('profile:set', { displayName: 'Alice, restored' })
  await carol.until('space:members', { spaceId }, (r) => Array.isArray(r) && r.some((m) => m.publicKey === aliceKey && m.displayName === 'Alice, restored'), { ms: 120000, every: 1000 })

  await back.until('files:list', { spaceId }, (list) => list.some((f) => f.path === '/after.bin'), { ms: 180000, every: 1000 })
  t.pass('the file shared after the backup is in the restored catalog, caught up from Carol')
  await share(t, back, spaceId, 'restored.bin', 3)
  await waitForCatalogEntry(carol, spaceId, '/restored.bin', { ms: 180000 })
  t.pass('a file shared after the restore reaches Carol')
  t.absent(sawFork(restoring, back, carol), 'no peer saw two histories of any core')
})
