import test from 'brittle'
import { freshDurable, freshPeer } from '../helpers/store.js'
import { getIntentsBee } from '../../src/shared/core/intent-store.js'
import { createIntentLog, INTENT_PREFIX } from '../../src/shared/core/intents.js'
import { createOwnedMount, getOwnedMount, createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { publishShare, readOwnShares } from '../../src/shared/shares/shares.js'
import { createSpace } from '../../src/shared/spaces/space.js'

const settle = () => new Promise((r) => setTimeout(r, 30))

// REGRESSION (FIX-INTENT-1: owned-folder:delete writes the mount record and the share tombstone to
// two different bees. A crash between them left the share still advertised with no mount behind it
// — a co-member reading our profile bee would re-surface a folder we had deleted.)
test('REGRESSION (FIX-INTENT-1): a half-finished owned delete is completed at the next boot', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Photos')
  const share = await publishShare(space.spaceId, { name: 'Album', id: 'sh-1' })
  await createOwnedMount({ spaceId: space.spaceId, shareId: 'sh-1', mountPath: ctx.tmpDir('src') })

  // Simulate the crash: the intent is written, the mount record is dropped, and the process dies
  // before the share tombstone lands.
  const intents = createIntentLog({ bee: getIntentsBee })
  intents.register('owned-delete', async () => {})
  await intents.begin('owned-delete', { spaceId: space.spaceId, shareId: 'sh-1' })
  const { deleteOwnedMount } = await import('../../src/shared/folders/mount-store.js')
  await deleteOwnedMount(space.spaceId, 'sh-1')

  t.is((await readOwnShares(space.spaceId)).length, 1, 'the share is still advertised — the half state')
  t.absent(await getOwnedMount(space.spaceId, 'sh-1'), 'while its mount is already gone')

  // The recovery a boot would run.
  const recovering = createIntentLog({ bee: getIntentsBee })
  const { tombstoneShare } = await import('../../src/shared/shares/shares.js')
  recovering.register('owned-delete', async ({ spaceId, shareId }) => {
    await deleteOwnedMount(spaceId, shareId)
    await tombstoneShare(spaceId, shareId)
  })
  await recovering.recover()

  t.is((await readOwnShares(space.spaceId)).length, 0, 'the share advertisement is retired')
  t.is((await recovering.list()).length, 0, 'and the intent record is cleared')
})

test('a half-finished foreign unmount is completed at the next boot', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Docs')
  await createForeignMount({ spaceId: space.spaceId, shareId: 'sh-2', mountPath: ctx.tmpDir('mirror'), ownerKey: 'a'.repeat(64) })

  const intents = createIntentLog({ bee: getIntentsBee })
  intents.register('foreign-unmount', async () => {})
  await intents.begin('foreign-unmount', { spaceId: space.spaceId, shareId: 'sh-2' })
  t.ok(await getForeignMount(space.spaceId, 'sh-2'), 'the mount record is still there — the half state')

  const recovering = createIntentLog({ bee: getIntentsBee })
  const { unmountForeignFolder } = await import('../../src/shared/folders/foreign-folders.js')
  recovering.register('foreign-unmount', async ({ spaceId, shareId }) => {
    await unmountForeignFolder(spaceId, shareId)
  })
  await recovering.recover()

  t.absent(await getForeignMount(space.spaceId, 'sh-2'), 'the mount record is gone')
  t.is((await recovering.list()).length, 0, 'and the intent is cleared')
})

// Forward compatibility across an OTA rollout: an older build must never eat a record it has no
// reconciler for, or a downgrade would silently drop a newer build's pending work.
test('an intent for an unknown kind survives a boot untouched', async (t) => {
  await freshDurable(t)
  const bee = getIntentsBee()
  await bee.put(INTENT_PREFIX + 'future-flow/1-0', { kind: 'future-flow', args: { x: 1 }, at: Date.now() })

  const intents = createIntentLog({ bee: getIntentsBee })
  intents.register('owned-delete', async () => {})
  await intents.recover()
  await settle()

  const left = await intents.list()
  t.is(left.length, 1, 'still there')
  t.is(left[0].kind, 'future-flow')
})

// The record has to be readable by a log instance that did not write it — that is what a next-boot
// recovery is, and it is what a purely in-memory map would fail.
test('an intent written by one log instance is read by another', async (t) => {
  await freshDurable(t)
  const writer = createIntentLog({ bee: getIntentsBee })
  writer.register('owned-delete', async () => {})
  await writer.begin('owned-delete', { spaceId: 's', shareId: 'sh' })

  const reader = createIntentLog({ bee: getIntentsBee })
  reader.register('owned-delete', async () => {})
  const left = await reader.list()
  t.is(left.length, 1, 'the record is in the bee, not in the writer')
  t.is(left[0].args.shareId, 'sh')
})
