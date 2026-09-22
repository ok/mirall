// The filesystem watcher's side of a mirror: one event in, at most one walk request out. Only a
// path the mirror wrote is its concern — a user's own file beside the mirrored ones is nothing a
// walk could act on, and an editor saving one every few seconds must not drive a walk each time.
// The watcher sees the mirror's own landings too, so an owned path's event is judged against the
// verified record: a file that is exactly the one the record fingerprinted is ours and costs
// nothing. Everything else on an owned path, a vanished file included, asks for the walk that
// settles it — the pass keeps a foreign edit as a conflicted copy and restores the owner's bytes,
// or fetches back what is missing.
import { entryRef } from '../contract/entry-ref.js'
import { createLogger } from '../core/logger.js'
import { isVerifiedLanding, statOrNull } from '../transfer/files.js'
import { mirrorOwnerKeyAt, requestMirrorWalk } from './foreign-verbs.js'
import { getForeignMount } from './mount-store.js'
import { pathFromMount } from './path-guard.js'

const log = createLogger('mirror-watcher')

export async function handleMirrorFsEvent({ spaceId, shareId, action, relPath }) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount || !mount.enabled) return
  const ownerKey = mirrorOwnerKeyAt(mount, relPath)
  if (!ownerKey) return
  if (action !== 'unlink' && await isOwnLanding(mount, ownerKey, relPath)) return
  log.debug('mirrored file changed on disk — asking for a walk:', action, relPath, shareId)
  requestMirrorWalk(spaceId, shareId, { now: true })
}

async function isOwnLanding(mount, ownerKey, relPath) {
  const stat = statOrNull(pathFromMount(mount.mountPath, relPath))
  if (!stat) return false
  return await isVerifiedLanding(mount.spaceId, entryRef(mount.shareId, ownerKey), stat, { expectLocal: relPath })
}
