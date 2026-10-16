import test from 'brittle'
import { settleSpaceFolders } from '../../src/worker/boot.js'
import { getNewSpaceDownloadDir } from '../../src/shared/core/paths.js'

function recordingLog() {
  const warned = []
  return { warned, log: { debug() {}, info() {}, warn: (...args) => warned.push(args.join(' ')), error() {} } }
}

// REGRESSION (FIX-DLTO-R26: one try held both boot steps, so a backfill write that failed — a full
// disk, an I/O error — skipped the recent list too, and the Download-to menu came up without the
// folders this device uses until the next choice or boot.)
test('REGRESSION (FIX-DLTO-R26: a failed space-folder backfill still hydrates the recent list)', async (t) => {
  const { warned, log } = recordingLog()
  const spaces = [{ spaceId: 's1' }]
  const hydrated = []
  await settleSpaceFolders(spaces, log, {
    backfill: async () => { throw new Error('ENOSPC') },
    hydrateRecent: async (list, seed) => { hydrated.push([list, seed]) },
  })
  t.alike(hydrated, [[spaces, getNewSpaceDownloadDir()]], 'the recent list is hydrated from the same spaces and seed')
  t.is(warned.length, 1, 'the backfill failure is logged')
  t.ok(warned[0].includes('ENOSPC'))
})

test('a failed recent-list hydrate is logged on its own', async (t) => {
  const { warned, log } = recordingLog()
  let backfilled = 0
  await settleSpaceFolders([], log, {
    backfill: async () => { backfilled++ },
    hydrateRecent: async () => { throw new Error('EIO') },
  })
  t.is(backfilled, 1)
  t.is(warned.length, 1)
  t.ok(warned[0].includes('EIO'))
})
