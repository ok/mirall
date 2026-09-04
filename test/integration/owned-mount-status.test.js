import test from 'brittle'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createOwnedMount, getOwnedMount, listOwnedMounts, setOwnedMountStatus, touchOwnedMountScan } from '../../src/shared/folders/mount-store.js'

async function plantedMount (t) {
  const ctx = await freshPeer(t)
  const mount = {
    spaceId: 'space1',
    shareId: 'share1',
    mountPath: path.join(ctx.tmpDir('owned'), 'Docs'),
    ignore: [],
    createdAt: Date.now(),
  }
  await createOwnedMount(mount)
  return mount
}

// An owned mount's scan failure lived only in a transient renderer event: a reload or
// restart lost the badge while the share kept publishing nothing. The status (and its
// error) must persist on the mount record so boot and refresh re-derive the truth.
test('REGRESSION (FIX-F1: an owned-mount scan failure persists on the mount record)', async (t) => {
  const mount = await plantedMount(t)

  t.ok(await setOwnedMountStatus(mount.spaceId, mount.shareId, 'paused-error', 'EACCES: permission denied'),
    'status write lands on the existing record')

  const read = await getOwnedMount(mount.spaceId, mount.shareId)
  t.is(read.status, 'paused-error', 'durable status readable via owned-folder:get')
  t.is(read.lastError, 'EACCES: permission denied', 'the error detail rides along')

  const listed = (await listOwnedMounts()).find((m) => m.shareId === mount.shareId)
  t.is(listed.status, 'paused-error', 'owned-folder:list-all carries the status for the badge derive')
  t.is(listed.mountPath, mount.mountPath, 'the rest of the record is untouched')
})

test('a healthy transition clears the persisted error', async (t) => {
  const mount = await plantedMount(t)
  await setOwnedMountStatus(mount.spaceId, mount.shareId, 'paused-error', 'boom')

  await setOwnedMountStatus(mount.spaceId, mount.shareId, 'active')

  const read = await getOwnedMount(mount.spaceId, mount.shareId)
  t.is(read.status, 'active')
  t.is(read.lastError, null, 'stale error dropped with the recovery')
})

test('a status write for an unmounted share is a no-op', async (t) => {
  await plantedMount(t)

  t.absent(await setOwnedMountStatus('space1', 'no-such-share', 'active'), 'reports the miss')
  t.absent(await getOwnedMount('space1', 'no-such-share'), 'no record conjured for a deleted mount')
})

// A minutes-long scan used to end with createOwnedMount(startOfScanObject), clobbering any
// status a concurrent probe/relocate persisted mid-scan. touchOwnedMountScan must merge the
// scan stamp onto the CURRENT record, preserving that fresher status.
test('REGRESSION (FIX-15: the scan stamp merge preserves a status written mid-scan)', async (t) => {
  const mount = await plantedMount(t)

  // Simulate: the scan started (record read), then a probe persisted 'paused-error' mid-scan,
  // then the scan completes and stamps its scan time.
  await setOwnedMountStatus(mount.spaceId, mount.shareId, 'paused-error', 'disk full')
  await touchOwnedMountScan(mount.spaceId, mount.shareId)

  const read = await getOwnedMount(mount.spaceId, mount.shareId)
  t.is(read.status, 'paused-error', 'mid-scan status survives the scan-time stamp')
  t.is(read.lastError, 'disk full', 'and its error detail')
  t.ok(read.lastScanCompletedAt > 0, 'scan time was recorded')
})
