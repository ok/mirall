import test from 'brittle'
import { isMountFault, mountFault } from '../../src/renderer/mountFault.js'
import { OWNED_MOUNT_STATUS, FOREIGN_MOUNT_STATUS } from '../../src/shared/contract/statuses.js'

// The projection that decides whether a folder screen shows a fault at all. Before it, both fault
// statuses were durably recorded and rendered nowhere: every consumer of mount.status compared
// against 'mount-point-gone' or 'paused' only.

test('the two fault statuses are faults and nothing else is', (t) => {
  t.ok(isMountFault('paused-error'))
  t.ok(isMountFault('paused-enospc'))
  for (const status of ['active', 'scanning', 'idle', 'paused', 'mount-point-gone', null, undefined, '']) {
    t.absent(isMountFault(status), `${String(status)} is not a fault`)
  }
})

test('a missing source is not a fault — it has its own status, its own strip and its own verb', (t) => {
  t.is(mountFault('mount-point-gone', null), null)
})

test('a user pause is not a fault', (t) => {
  t.is(mountFault('paused', null), null)
})

test('the recorded reason travels as the fault code', (t) => {
  t.alike(mountFault('paused-error', 'TRANSFER_PERMISSION'), { status: 'paused-error', code: 'TRANSFER_PERMISSION' })
})

// A mirror's fault reason was event-only before this shipped, so a record already on disk carries
// a status and no reason. The status names the disk-full case by itself.
test('a fault with no recorded reason still names itself where the status can', (t) => {
  t.is(mountFault('paused-enospc', null).code, 'TRANSFER_DISK_FULL')
  t.is(mountFault('paused-enospc', undefined).code, 'TRANSFER_DISK_FULL')
  t.is(mountFault('paused-error', null).code, null, 'and stays generic where it cannot')
})

test('every fault status is one both roles can actually record', (t) => {
  for (const status of ['paused-error', 'paused-enospc']) {
    t.ok(OWNED_MOUNT_STATUS.includes(status), `an owned mount can record ${status}`)
    t.ok(FOREIGN_MOUNT_STATUS.includes(status), `a mirror can record ${status}`)
  }
})
