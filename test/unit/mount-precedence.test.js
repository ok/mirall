import test from 'brittle'
import { ownedMountStatus, isFaultStatus, isHealthyOwnedStatus, _rankForTests } from '../../src/shared/contract/mount-precedence.js'
import { MOUNT_STATUS, OWNED_MOUNT_STATUSES } from '../../src/shared/contract/statuses.js'

test('the precedence resolves every combination to exactly one status', (t) => {
  const cases = [
    [{ status: MOUNT_STATUS.ACTIVE }, MOUNT_STATUS.ACTIVE],
    [{ status: MOUNT_STATUS.SCANNING }, MOUNT_STATUS.SCANNING],
    [{ status: MOUNT_STATUS.ACTIVE, indexPaused: true }, MOUNT_STATUS.PAUSED],
    [{ status: MOUNT_STATUS.SCANNING, indexPaused: true }, MOUNT_STATUS.PAUSED],
    [{ status: MOUNT_STATUS.PAUSED_ERROR, indexPaused: true }, MOUNT_STATUS.PAUSED_ERROR],
    [{ status: MOUNT_STATUS.PAUSED_ENOSPC, indexPaused: true }, MOUNT_STATUS.PAUSED_ENOSPC],
    [{ status: MOUNT_STATUS.MOUNT_POINT_GONE, indexPaused: true }, MOUNT_STATUS.MOUNT_POINT_GONE],
    [{ status: MOUNT_STATUS.PAUSED_ERROR, mountPointMissing: true }, MOUNT_STATUS.MOUNT_POINT_GONE],
    [{ status: MOUNT_STATUS.SCANNING, mountPointMissing: true }, MOUNT_STATUS.MOUNT_POINT_GONE],
    [{ status: undefined }, MOUNT_STATUS.SCANNING],
    [{}, MOUNT_STATUS.SCANNING],
  ]
  for (const [record, expected] of cases) {
    t.is(ownedMountStatus(record), expected, JSON.stringify(record))
  }
  t.is(ownedMountStatus(null), null, 'no record is no status')
})

// REGRESSION (A.4): the fault is what the user can act on, so it shows — but the pause is a
// separate fact and is still there when the fault clears.
test('REGRESSION (A.4): a fault hides a pause without erasing it', (t) => {
  const faulted = { status: MOUNT_STATUS.PAUSED_ERROR, indexPaused: true }
  t.is(ownedMountStatus(faulted), MOUNT_STATUS.PAUSED_ERROR, 'the fault is what shows')
  t.is(ownedMountStatus({ ...faulted, status: MOUNT_STATUS.ACTIVE }), MOUNT_STATUS.PAUSED,
    'and the pause is what is left once a clean pass clears the fault')
})

test('a missing source outranks an I/O fault', (t) => {
  t.is(ownedMountStatus({ status: MOUNT_STATUS.PAUSED_ENOSPC, mountPointMissing: true }),
    MOUNT_STATUS.MOUNT_POINT_GONE, 'the remedy is Locate, not Try again')
})

test('isFaultStatus names the statuses only a fresh pass can clear', (t) => {
  for (const s of [MOUNT_STATUS.MOUNT_POINT_GONE, MOUNT_STATUS.PAUSED_ENOSPC, MOUNT_STATUS.PAUSED_ERROR]) {
    t.ok(isFaultStatus(s), `${s} is a fault`)
  }
  for (const s of [MOUNT_STATUS.PAUSED, MOUNT_STATUS.SCANNING, MOUNT_STATUS.ACTIVE, MOUNT_STATUS.IDLE]) {
    t.absent(isFaultStatus(s), `${s} is not a fault`)
  }
  t.absent(isFaultStatus(undefined), 'an unwritten status is not a fault')
})

test('isHealthyOwnedStatus is the pair that renders no badge', (t) => {
  t.ok(isHealthyOwnedStatus(MOUNT_STATUS.ACTIVE))
  t.ok(isHealthyOwnedStatus(MOUNT_STATUS.SCANNING))
  for (const s of [MOUNT_STATUS.PAUSED, MOUNT_STATUS.PAUSED_ERROR, MOUNT_STATUS.MOUNT_POINT_GONE]) {
    t.absent(isHealthyOwnedStatus(s), `${s} deserves a badge`)
  }
})

test('every owned status the contract declares has a rank', (t) => {
  for (const status of OWNED_MOUNT_STATUSES) {
    t.is(typeof _rankForTests[status], 'number', `${status} is ranked`)
  }
  t.ok(_rankForTests[MOUNT_STATUS.MOUNT_POINT_GONE] > _rankForTests[MOUNT_STATUS.PAUSED_ERROR],
    'a missing source outranks a fault')
  t.ok(_rankForTests[MOUNT_STATUS.PAUSED_ERROR] > _rankForTests[MOUNT_STATUS.PAUSED],
    'a fault outranks a pause')
  t.ok(_rankForTests[MOUNT_STATUS.PAUSED] > _rankForTests[MOUNT_STATUS.SCANNING],
    'a pause outranks activity')
})
