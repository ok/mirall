// The reconcilers for every folder flow that writes to more than one bee: what the next boot runs
// against an intent record a crashed process left behind. They live here rather than in the
// composition root so the tests that assert them exercise the shipped reconciler instead of a copy
// re-declared in the test file — which is what made the highest-consequence branch below (the
// "the mount did land" guard) untested.
//
// Every one is idempotent, because recover() may run a reconciler that already half-succeeded.
import { deleteOwnedMount, getOwnedMount } from './mount-store.js'
import { tombstoneShare } from '../shares/shares.js'
import { unmountForeignFolder } from './foreign-folders.js'

export function registerFolderIntents(intents) {
  intents.register('owned-delete', async ({ spaceId, shareId }) => {
    await deleteOwnedMount(spaceId, shareId)
    await tombstoneShare(spaceId, shareId)
  })

  intents.register('foreign-unmount', async ({ spaceId, shareId }) => {
    await unmountForeignFolder(spaceId, shareId)
  })

  // A share whose mount never landed is a folder the user did not finish creating. Retire the
  // advertisement rather than resurrecting it: we do not know which folder on disk they meant, and
  // a mount-less share is invisible to every owner-side pass, so leaving it would strand it on
  // every co-member forever.
  intents.register('share-create-mount', async ({ spaceId, shareId }) => {
    // The crash could equally have landed AFTER both writes and before the intent was cleared. Both
    // writes are good in that case and the recovery must do nothing — deleting here would destroy a
    // folder the user successfully created.
    if (await getOwnedMount(spaceId, shareId)) return
    await tombstoneShare(spaceId, shareId)
  })
}
