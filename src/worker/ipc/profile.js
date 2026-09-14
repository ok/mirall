// The local identity surface. A name change has to reach three places: the profile record, the
// audit identity every later row is stamped with, and the peers holding an open member view.

import { getProfile, setProfile } from '../../shared/spaces/profile.js'
import { broadcastProfileUpdate } from '../../shared/network/swarm.js'
import { refreshAuditSelfName } from '../audit-refs.js'

export function registerProfile(ipc, { log }) {
  ipc.handle('profile:get', async () => await getProfile())
  ipc.handle('profile:set', async (msg) => {
    await setProfile({ displayName: msg.displayName, avatar: msg.avatar })
    refreshAuditSelfName(msg.displayName)
    broadcastProfileUpdate().catch(err => log.warn('profile broadcast failed:', err.message))
    return await getProfile()
  })
}
