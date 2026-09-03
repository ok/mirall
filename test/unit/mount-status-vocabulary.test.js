import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { OWNED_MOUNT_STATUS, FOREIGN_MOUNT_STATUS } from '../../src/shared/contract/statuses.js'

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
  'renderer/mountFault.js',
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
