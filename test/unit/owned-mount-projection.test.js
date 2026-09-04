import test from 'brittle'
import { projectOwnedMount, ownedMountSettled, unhealthyOwnedStatus, NO_OWNED_MOUNT } from '../../src/renderer/ownedMount.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

const row = (over = {}) => ({ spaceId: 'sp1', shareId: 'sh1', status: 'active', mountPath: '/a', ...over })

test('unhealthyOwnedStatus reports only the states that deserve a badge', (t) => {
  t.is(unhealthyOwnedStatus(null), null, 'no row is not a fault')
  t.is(unhealthyOwnedStatus(row()), null, 'active is healthy')
  t.is(unhealthyOwnedStatus(row({ status: 'scanning' })), null, 'so is scanning')
  t.is(unhealthyOwnedStatus(row({ status: 'paused-error' })), 'paused-error', 'a persisted fault shows')
  t.is(
    unhealthyOwnedStatus(row({ status: 'scanning', mountPointMissing: true })),
    'mount-point-gone',
    'a live missing path outranks the durable status',
  )
})

test('an unsettled read is distinguishable from a share with no row', (t) => {
  t.alike(projectOwnedMount(undefined, 'sp1', 'sh1', false), NO_OWNED_MOUNT, 'nothing read yet → loaded:false')
  // The distinction FolderView depends on: loaded:false pins it to the frozen navigation snapshot,
  // so reporting it for a folder that simply was never mounted would freeze that folder forever.
  t.alike(
    projectOwnedMount([], 'sp1', 'sh1', true),
    { status: null, lastError: null, loaded: true, indexPaused: false, scanning: false, mountPath: null },
    'settled with no row → loaded:true, healthy',
  )
})

// REGRESSION (REVIEW-1: the hook derived `settled` from the store's `loading` —
// `!(loading && data === undefined)`. The store settles an entry on an ERROR as well as on data, so
// a FAILED owned-folder:list-all read reports loading:false with data undefined, and that
// expression called it settled. projectOwnedMount then found no row for the share and returned the
// healthy answer with loaded:true, which FolderView takes outright — so a folder durably
// paused-error or mount-point-gone painted with no fault strip, no Try again and a null mountPath,
// exactly when the worker was least able to correct it. The hand-rolled version this replaced left
// loaded:false on a rejection and fell back to share.mountStatus.)
test('REGRESSION (REVIEW-1): a failed read is not settled, so the fault strip survives it', (t) => {
  t.absent(ownedMountSettled(true, undefined), 'no rows means no answer, whatever the reason')
  t.ok(ownedMountSettled(true, []), 'an empty listing IS an answer — this share was never mounted')
  t.ok(ownedMountSettled(true, [row()]), 'and so is a listing with rows')
  t.absent(ownedMountSettled(false, [row()]), 'a disabled hook has no answer to give')

  // The consequence, end to end: what FolderView receives when the read rejected.
  t.alike(projectOwnedMount(undefined, 'sp1', 'sh1', ownedMountSettled(true, undefined)), NO_OWNED_MOUNT,
    'loaded:false, so FolderView falls back to the share mount status it already had')
})

// The trap is a parameter the function does not have, as with profileGate. This pins that shape,
// because the bug was one word in the caller.
test('REGRESSION (REVIEW-1): the hook does not take the store loading flag', (t) => {
  const src = readFileSync(path.join(root, 'src', 'renderer', 'hooks', 'useFolderMount.ts'), 'utf8')
  const destructure = /const\s*\{([^}]*)\}\s*=\s*useQuery</.exec(src)
  t.ok(destructure, 'useOwnedMount still reads the listing through the query store')
  t.absent(/\bloading\b/.test(destructure[1]),
    'and does not take `loading` off it — an error settles the entry with no data')
})

test('missing ids read as no mount, whatever the listing holds', (t) => {
  t.alike(projectOwnedMount([row()], '', 'sh1', true), NO_OWNED_MOUNT, 'no spaceId')
  t.alike(projectOwnedMount([row()], 'sp1', '', true), NO_OWNED_MOUNT, 'no shareId')
})

test('every field is read from the row, so nothing latches across a share change', (t) => {
  const rows = [
    row({ shareId: 'sh1', status: 'paused-error', lastError: 'ENOSPC', indexPaused: true }),
    row({ shareId: 'sh2', status: 'scanning', mountPath: '/b' }),
  ]

  t.alike(projectOwnedMount(rows, 'sp1', 'sh1', true), {
    status: 'paused-error', lastError: 'ENOSPC', loaded: true, indexPaused: true, scanning: false, mountPath: '/a',
  })
  // The same call for the sibling share carries none of sh1's state — the leak the hand-rolled
  // hook had, where `loaded` and `status` survived a navigation because only the effect reset them.
  t.alike(projectOwnedMount(rows, 'sp1', 'sh2', true), {
    status: null, lastError: null, loaded: true, indexPaused: false, scanning: true, mountPath: '/b',
  })
})

test('rows from another space are never matched', (t) => {
  const rows = [row({ spaceId: 'sp2', status: 'paused-error' })]
  t.is(projectOwnedMount(rows, 'sp1', 'sh1', true).status, null, 'same shareId, different space')
})
