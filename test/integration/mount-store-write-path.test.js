import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import {
  createOwnedMount, getOwnedMount, deleteOwnedMount,
  patchOwnedMount, setOwnedActivity, setOwnedFault, setOwnedIndexPaused, touchOwnedMountScan,
} from '../../src/shared/folders/mount-store.js'

const KEY = { spaceId: 'sp-1', shareId: 'sh-1' }

async function seed(t) {
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
    setOwnedFault(KEY.spaceId, KEY.shareId, 'paused-error', 'ENOSPC'),
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
    patchOwnedMount(KEY.spaceId, KEY.shareId, { mountPath: '/new' }),
    deleteOwnedMount(KEY.spaceId, KEY.shareId),
  ])

  t.absent(await getOwnedMount(KEY.spaceId, KEY.shareId), 'the mount stays unmounted')
})

test('the read-merge helpers still report a missing record rather than creating one', async (t) => {
  await freshPeer(t)
  t.is(await patchOwnedMount('sp-x', 'sh-x', { mountPath: '/x' }), false, 'patch declines')
  t.is(await setOwnedActivity('sp-x', 'sh-x', 'active'), false, 'status declines')
  t.is(await setOwnedIndexPaused('sp-x', 'sh-x', true), false, 'pause declines')
  t.absent(await getOwnedMount('sp-x', 'sh-x'), 'and none of them created one')
})

// REGRESSION (A.4): `status` is resolved from the facts beside it, so a patch that assigns one would
// be the blind write the precedence exists to remove — and `indexPaused` is one of those facts.
test('REGRESSION (A.4): a patch cannot assign a derived field', async (t) => {
  await seed(t)

  await t.exception(() => patchOwnedMount(KEY.spaceId, KEY.shareId, { status: 'active' }), /derived/)
  await t.exception(() => patchOwnedMount(KEY.spaceId, KEY.shareId, { indexPaused: true }), /derived/)

  const mount = await getOwnedMount(KEY.spaceId, KEY.shareId)
  t.absent(mount.status, 'neither reached the record')
  t.absent(mount.indexPaused)
})

// REGRESSION (A.4): the pause and the fault are separate facts, so a fault landing over a pause
// shows the fault and leaves the intent standing for the pass that clears it.
test('REGRESSION (A.4): a fault over a pause hides it without erasing it', async (t) => {
  await seed(t)

  await setOwnedIndexPaused(KEY.spaceId, KEY.shareId, true)
  t.is((await getOwnedMount(KEY.spaceId, KEY.shareId)).status, 'paused', 'the pause shows')

  await setOwnedFault(KEY.spaceId, KEY.shareId, 'paused-enospc', 'TRANSFER_DISK_FULL')
  const faulted = await getOwnedMount(KEY.spaceId, KEY.shareId)
  t.is(faulted.status, 'paused-enospc', 'the fault outranks it')
  t.ok(faulted.indexPaused, 'and the intent is still recorded')

  await setOwnedActivity(KEY.spaceId, KEY.shareId, 'active')
  const cleared = await getOwnedMount(KEY.spaceId, KEY.shareId)
  t.is(cleared.status, 'paused', 'a clean pass clears the fault and the pause resurfaces')
  t.is(cleared.lastError, null, 'with its reason')
})
