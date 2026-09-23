// @ts-check
// The local identity surface. A name change has to reach three places: the profile record, the
// audit identity every later row is stamped with, and the peers holding an open member view.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { Logger } from '../../shared/core/logger.js' */
import { getProfile, setProfile } from '../../shared/spaces/profile.js'
import { broadcastProfileUpdate } from '../../shared/network/identity-frames.js'
import { refreshAuditSelfName } from '../audit-refs.js'
import { AppError, errorMessage } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'

/** @param {WorkerIpc} ipc @param {{ log: Logger }} deps */
export function registerProfile(ipc, { log }) {
  ipc.handle('profile:get', async () => await getProfile())
  ipc.handle('profile:set', async (msg) => {
    await setProfile({ displayName: msg.displayName, avatar: msg.avatar })
    // profile:set answers with the profile it wrote, or fails: never with null.
    const profile = await getProfile()
    if (!profile) throw new AppError(CODES.UNKNOWN, 'the profile could not be read back')
    refreshAuditSelfName(profile.displayName)
    broadcastProfileUpdate().catch(err => log.warn('profile broadcast failed:', errorMessage(err)))
    return profile
  })
}
