import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import {
  createOwnedMount, getOwnedMount, deleteOwnedMount,
  patchOwnedMount, setOwnedMountStatus, setOwnedIndexPaused, touchOwnedMountScan,
} from '../../src/shared/folders/mount-store.js'

const KEY = { spaceId: 'sp-1', shareId: 'sh-1' }

async function seed (t) {
  await freshPeer(t)
  await createOwnedMount({ ...KEY, mountPath: '/old', ignore: [], createdAt: Date.now() })
}

// REGRESSION (FIX-R05-2b: relocate wrote back the whole `mount` object it had read at the top of the
// handler, with validateMountPath running in between. Any status a probe or a scan settle persisted
// in that window was silently dropped by the stale copy — which is the recurring bug class: the
// field lost is always a latch nobody re-derives.)
test('REGRESSION (FIX-R05-2b): a relocate does not clobber a concurrent status write', async (t) => {
  await seed(t)

  await Promise.all([
    patchOwnedMount(KEY.spaceId, KEY.shareId, { mountPath: '/new' }),
    setOwnedMountStatus(KEY.spaceId, KEY.shareId, 'paused-error', 'ENOSPC'),
  ])

  const mount = await getOwnedMount(KEY.spaceId, KEY.shareId)
  t.is(mount.mountPath, '/new', 'the relocate landed')
  t.is(mount.status, 'paused-error', 'and so did the fault the probe recorded meanwhile')
  t.is(mount.lastError, 'ENOSPC', 'with its reason')
})

// The same shape at the site whose own comment describes the clobber it could only narrow: a scan
// settle stamps its timestamp from a record read before a pass that can run for minutes.
test('a pause set during a scan settle survives it', async (t) => {
  await seed(t)

  await Promise.all([
    touchOwnedMountScan(KEY.spaceId, KEY.shareId),
    setOwnedIndexPaused(KEY.spaceId, KEY.shareId, true),
  ])

  const mount = await getOwnedMount(KEY.spaceId, KEY.shareId)
  t.ok(mount.indexPaused, 'the user intent survived')
  t.ok(mount.lastScanCompletedAt > 0, 'and so did the scan stamp')
})

// cas is never invoked for an absent key, so ordering is the only thing that can stop a mutation
// from writing a record an unmount has just deleted straight back into the bee.
test('an unmount racing a patch does not resurrect the record', async (t) => {
  await seed(t)

  await Promise.all([
    patchOwnedMount(KEY.spaceId, KEY.shareId, { status: 'active' }),
    deleteOwnedMount(KEY.spaceId, KEY.shareId),
  ])

  t.absent(await getOwnedMount(KEY.spaceId, KEY.shareId), 'the mount stays unmounted')
})

test('the read-merge helpers still report a missing record rather than creating one', async (t) => {
  await freshPeer(t)
  t.is(await patchOwnedMount('sp-x', 'sh-x', { status: 'active' }), false, 'patch declines')
  t.is(await setOwnedMountStatus('sp-x', 'sh-x', 'active'), false, 'status declines')
  t.is(await setOwnedIndexPaused('sp-x', 'sh-x', true), false, 'pause declines')
  t.absent(await getOwnedMount('sp-x', 'sh-x'), 'and none of them created one')
})
