import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { getStore, createBee, createLocalBee } from '../../src/shared/core/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { getProfileBee, getProfile } from '../../src/shared/spaces/profile.js'
import { purgeLeftovers, classifyLeftovers } from '../../src/shared/storage/leftover.js'
import { cleanupOrphanedData } from '../../src/shared/storage/storage.js'
import { shouldReclaimOrphanDrives } from '../../src/shared/storage/legacy-orphan-drives.js'
import { listRecentSweeps } from '../../src/shared/storage/sweep-journal.js'

// D1 — the boot sweep must not delete on evidence it could not gather.
//
// cleanupOrphanedData hard-deletes every store core outside a "wanted" set, via a RocksDB range
// delete with no backup and no undo. That set was built best-effort: six failure paths logged a
// warning (one did not even do that) and let the sweep proceed on the shorter set. Only ONE of them
// set a safety flag, and that flag withheld a single category — `profiles` and `catalogs` were
// purged regardless. A transient read failure was therefore promoted to "the user no longer needs
// this", permanently and silently.

async function coreInStore (dkHex) {
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

async function plantStray (name, key, value) {
  const bee = createBee(name)
  await bee.ready()
  await bee.put(key, value)
  const dk = b4a.toString(bee.core.discoveryKey, 'hex')
  await bee.close()
  return dk
}

// One system bee refuses to open. Anything can cause this — a lock held by a dying instance, disk
// pressure, a half-written core — and none of it means the user's data is disposable.
const failOpening = (name) => (n) => {
  if (n === name) throw new Error('simulated transient open failure')
  return createLocalBee(n)
}

test('REGRESSION (FIX-D1-1): a gap in the wanted set withholds every category', async (t) => {
  await freshPeer(t)
  await createSpace('Aurora')
  const strayDk = await plantStray('past-peer-profile-sim', 'displayName', 'Ghost')
  t.ok(await coreInStore(strayDk), 'precondition: the stray is present')

  const res = await purgeLeftovers({ openSystemBee: failOpening('spaces-meta') })

  t.is(res.purged, 0, 'nothing was purged on an incomplete scan')
  t.is(res.refused, 'scan-incomplete')
  t.ok(await coreInStore(strayDk), 'the stray survived — "unwanted" did not mean "unneeded"')
})

test('REGRESSION (FIX-D1-2): the device profile core survives a failed read of itself', async (t) => {
  await freshPeer(t)
  await createSpace('Aurora')
  const profileDk = b4a.toString(getProfileBee().core.discoveryKey, 'hex')
  // A target must exist, or the sweep is trivially allowed and proves nothing.
  await plantStray('past-peer-profile-sim', 'displayName', 'Ghost')

  // The profile bee is opened twice when building the set: once by name in WANTED_BEE_GROUPS and
  // once as the live handle. Fail the first, and on staging the second's bare `catch {}` was the
  // only thing between the device identity bee and a purge that classified it as a stray 'profile'.
  const res = await purgeLeftovers({ openSystemBee: failOpening('profile') })

  t.is(res.refused, 'scan-incomplete')
  t.ok(await coreInStore(profileDk), 'the device profile core is still on disk')
  t.ok(await getProfile(), 'and still readable')
})

test('REGRESSION (FIX-D1-3): an implausibly large target set is refused wholesale, not trimmed', async (t) => {
  await freshPeer(t)
  await createSpace('Aurora')

  const strays = []
  for (let i = 0; i < 25; i++) strays.push(await plantStray('stray-profile-' + i, 'displayName', 'Ghost ' + i))

  const scan = await classifyLeftovers()
  t.ok(scan.scanComplete, 'precondition: this scan is complete, so only the magnitude gate can refuse')

  const res = await purgeLeftovers()
  t.is(res.refused, 'over-ratio-cap', 'more than half the store is not a reclaim, it is a wipe')
  t.is(res.purged, 0)
  for (const dk of strays) t.ok(await coreInStore(dk), 'every target survived — a refusal is all-or-nothing')
})

test('D1: a complete scan with a plausible target set still reclaims', async (t) => {
  await freshPeer(t)
  await createSpace('Aurora')
  const strayDk = await plantStray('past-peer-profile-sim', 'displayName', 'Ghost')

  const res = await purgeLeftovers()
  t.is(res.refused, null, 'a healthy sweep is not refused')
  t.ok(res.purged >= 1)
  t.absent(await coreInStore(strayDk), 'the stray was reclaimed — the guard did not disable the feature')
})

test('D1: the journal records what a sweep did, and why it refused', async (t) => {
  await freshPeer(t)
  await createSpace('Aurora')
  const strayDk = await plantStray('past-peer-profile-sim', 'displayName', 'Ghost')

  await purgeLeftovers()
  const [done] = await listRecentSweeps(1)
  t.is(done.refused, null, 'the successful pass is recorded')
  t.ok(done.purgedDks.includes(strayDk), 'with the discovery keys it deleted')

  await plantStray('another-past-peer', 'displayName', 'Ghost 2')
  await purgeLeftovers({ openSystemBee: failOpening('spaces-meta') })
  const [refused] = await listRecentSweeps(1)
  t.is(refused.refused, 'scan-incomplete', 'the refusal is recorded too')
  t.ok(refused.gaps.some((g) => g.stage === 'system-bee:spaces-meta'), 'naming the gap that caused it')
})

test('REGRESSION (FIX-D1-4): a refused sweep does not consume the one-shot orphan-drive pass', async (t) => {
  await freshPeer(t)
  await createSpace('Aurora')

  // Booting the peer already ran one sweep, which consumed the flag. Put it back, because the
  // property under test is what a REFUSED sweep does to it.
  const flags = createLocalBee('app-migrations')
  await flags.ready()
  await flags.del('legacy-orphan-drive-reclaim-v1')
  await flags.close()
  t.ok(await shouldReclaimOrphanDrives(), 'precondition: the one-shot pass is owed again')

  // Refuse through a real condition rather than a seam: cleanupOrphanedData takes no injection
  // point, and an implausible target set reaches the same branch.
  for (let i = 0; i < 25; i++) await plantStray('stray-profile-' + i, 'displayName', 'Ghost ' + i)

  const { purged, refused } = await cleanupOrphanedData()
  t.is(refused, 'over-ratio-cap', 'the boot sweep refused')
  t.is(purged, 0)

  t.ok(await shouldReclaimOrphanDrives(),
    'the one-shot pass survives — a refused sweep looked at nothing, so it must not spend it')
})
