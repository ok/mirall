import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { OWNED_MOUNT_STATUS, FOREIGN_MOUNT_STATUS } from '../../src/shared/contract/statuses.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'
import {
  AUTO_PAUSE_STATUSES, statusForFaultCode, faultFromError, isAutoPauseStatus, mountFault, isMountFault,
} from '../../src/shared/folders/mount-fault.js'

// The mount status vocabularies were hand-written TypeScript unions until this shipped, and they
// had already drifted: the mirror wrote 'paused-enospc', the owned union had never heard of it.
// The unions are derived from the contract now, so the remaining half of the promise is this —
// every status the writers put on a record is one the contract declares.
//
// Source-scanned rather than imported: the writers are Bare modules (bare-fs, corestore), so a
// Node runner cannot load them. The pattern matches anything status-SHAPED, which is what makes a
// new 'paused-<something>' literal fail here instead of reaching the renderer as an unknown.

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => fs.readFileSync(path.resolve(here, '../../src', p), 'utf8')

const STATUS_SHAPED = /'(idle|active|scanning|paused|paused-[a-z]+|mount-point-gone)'/g

const WRITERS = [
  'shared/folders/foreign-folders.js',
  'worker/mounts-runtime.js',
  // Writes owned statuses directly (mount, relocate) and emits a mirror one, so leaving it out
  // made the promise above narrower than it reads.
  'worker/main.js',
  // The shared writer both roles now go through. renderer/mountFault.js and
  // shared/folders/mount-fault.js re-export it and hold no literals of their own.
  'shared/contract/mount-fault.js',
]

const declared = new Set([...OWNED_MOUNT_STATUS, ...FOREIGN_MOUNT_STATUS])

for (const file of WRITERS) {
  test(`every mount status ${file} names is one the contract declares`, (t) => {
    const found = new Set([...read(file).matchAll(STATUS_SHAPED)].map((m) => m[1]))
    t.ok(found.size > 0, 'the scan found statuses at all (guards the pattern itself)')
    for (const status of found) t.ok(declared.has(status), `'${status}' is in the contract vocabulary`)
  })
}

test('the fault statuses both roles share are declared for both', (t) => {
  t.ok(OWNED_MOUNT_STATUS.includes('paused-enospc'), 'the drift this test exists for: the owned union lacked it')
  t.ok(FOREIGN_MOUNT_STATUS.includes('paused-enospc'))
  t.ok(FOREIGN_MOUNT_STATUS.includes('idle'), "and 'idle' stays mirror-only, which is why there are two")
  t.absent(OWNED_MOUNT_STATUS.includes('idle'))
})

// The promise the source scan could only approximate. Importable now that one bare-*-free module
// owns the decision, so this asserts the writer's whole output range rather than its spelling.
test('every status mount-fault.js can produce is declared for both roles', (t) => {
  const produced = new Set([
    ...AUTO_PAUSE_STATUSES,
    statusForFaultCode(ErrorCodes.TRANSFER_DISK_FULL),
    statusForFaultCode(ErrorCodes.TRANSFER_PERMISSION),
    statusForFaultCode(null),
  ])
  t.ok(produced.size >= 3, 'the set is non-trivial (guards the assertion itself)')
  for (const status of produced) {
    t.ok(OWNED_MOUNT_STATUS.includes(status), `owned declares '${status}'`)
    t.ok(FOREIGN_MOUNT_STATUS.includes(status), `foreign declares '${status}'`)
  }
})

test('the errno split both roles depend on', (t) => {
  t.is(faultFromError({ code: 'ENOSPC' }).status, 'paused-enospc')
  t.is(faultFromError({ code: 'ENOSPC' }).code, ErrorCodes.TRANSFER_DISK_FULL)
  t.is(faultFromError({ code: 'EACCES' }).status, 'paused-error')
  t.is(faultFromError({ code: 'EPERM' }).status, 'paused-error')
  t.is(faultFromError({ code: 'EROFS' }).status, 'paused-error')
  t.is(faultFromError({ code: 'ENOENT' }), null, 'ENOENT is ambiguous — the caller must probe the path')
  t.is(faultFromError({}), null)
  t.is(faultFromError(null), null, 'and a non-error never pauses a mount')
})

// A user pause must never be auto-resumable; that distinction is the whole reason the set exists.
test('a user pause is not an auto-pause', (t) => {
  t.absent(isAutoPauseStatus('paused'))
  t.absent(isAutoPauseStatus('active'))
  t.absent(isAutoPauseStatus('scanning'))
  t.absent(isAutoPauseStatus('idle'))
  for (const s of ['paused-enospc', 'paused-error', 'mount-point-gone']) t.ok(isAutoPauseStatus(s))
})

test('the renderer fault reader names a reason even when none was recorded', (t) => {
  t.alike(mountFault('paused-enospc', null), { status: 'paused-enospc', code: ErrorCodes.TRANSFER_DISK_FULL })
  t.alike(mountFault('paused-error', ErrorCodes.TRANSFER_PERMISSION), { status: 'paused-error', code: ErrorCodes.TRANSFER_PERMISSION })
  t.is(mountFault('paused-error', null).code, null, 'a plain error with no reason stays honest rather than guessing')
  t.is(mountFault('mount-point-gone', null), null, 'a missing root is not a fault banner')
  t.is(mountFault('paused', null), null)
  t.absent(isMountFault('paused'))
  t.ok(isMountFault('paused-error'))
})

// The layering constraint that makes one shared writer possible at all.
test('mount-fault.js is loadable outside Bare', (t) => {
  for (const f of ['shared/contract/mount-fault.js', 'shared/folders/mount-fault.js']) {
    t.absent(/from '(bare-[a-z]+)'/.test(read(f)), f + ': no bare-* import — the renderer bundles the contract half')
  }
})
