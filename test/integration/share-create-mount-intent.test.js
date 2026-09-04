import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { getIntentsBee } from '../../src/shared/core/intent-store.js'
import { createIntentLog } from '../../src/shared/core/intents.js'
import { registerFolderIntents } from '../../src/shared/folders/folder-intents.js'
import { createOwnedMount, getOwnedMount } from '../../src/shared/folders/mount-store.js'
import { publishShare, readOwnShares } from '../../src/shared/shares/shares.js'
import { createSpace } from '../../src/shared/spaces/space.js'

// The reconciler under test is the one the composition root registers — imported, not re-declared
// here — because the branch that matters most is the one that must do NOTHING.
function bootIntents() {
  const intents = createIntentLog({ bee: getIntentsBee })
  registerFolderIntents(intents)
  return intents
}

// REGRESSION (FIX-R05-9: creating a folder is two writes to two bees, and the FIRST one replicates:
// the share row lands in our profile bee, which every co-member reads, while the mount record sits
// behind a full disk walk. A crash in between left a folder advertised to the whole space with no
// mount behind it — and every owner-side pass skips a mount-less share, so nothing ever noticed and
// the user had no folder in their own list to delete.)
test('REGRESSION (FIX-R05-9): a share whose mount never landed is retired at the next boot', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Photos')
  const writing = bootIntents()
  await writing.begin('share-create-mount', { spaceId: space.spaceId, shareId: 'sh-1' })
  await publishShare(space.spaceId, { name: 'Album', id: 'sh-1' })

  t.is((await readOwnShares(space.spaceId)).length, 1, 'the share is advertised — the half state')
  t.absent(await getOwnedMount(space.spaceId, 'sh-1'), 'and no mount ever landed behind it')

  const recovering = bootIntents()
  await recovering.recover()

  t.is((await readOwnShares(space.spaceId)).length, 0, 'the advertisement is retired')
  t.is((await recovering.list()).length, 0, 'and the intent record is cleared')
})

// The crash can equally land AFTER both writes and before the intent is cleared. Deleting there
// would destroy a folder the user successfully created, which is a strictly worse outcome than the
// orphan the reconciler exists to clean up.
test('a share whose mount DID land survives the recovery untouched', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Photos')
  const intents = bootIntents()
  await intents.begin('share-create-mount', { spaceId: space.spaceId, shareId: 'sh-2' })
  await publishShare(space.spaceId, { name: 'Album', id: 'sh-2' })
  await createOwnedMount({ spaceId: space.spaceId, shareId: 'sh-2', mountPath: ctx.tmpDir('src') })

  await bootIntents().recover()

  t.is((await readOwnShares(space.spaceId)).length, 1, 'the folder the user created is still there')
  t.ok(await getOwnedMount(space.spaceId, 'sh-2'), 'with its mount record intact')
})

// recover() re-runs a reconciler whose own clear failed, so a second pass must be a no-op rather
// than a second, different outcome.
test('the recovery is idempotent', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Photos')
  const intents = bootIntents()
  await intents.begin('share-create-mount', { spaceId: space.spaceId, shareId: 'sh-3' })
  await publishShare(space.spaceId, { name: 'Album', id: 'sh-3' })

  await bootIntents().recover()
  await bootIntents().recover()

  t.is((await readOwnShares(space.spaceId)).length, 0, 'still retired')
  t.is((await bootIntents().list()).length, 0, 'and nothing is left to re-run')
})
