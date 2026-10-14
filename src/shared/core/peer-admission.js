// Who the listener admits, on top of bare-pipe's ownerOnly, which has already dropped other users
// at accept. This refuses what ownerOnly lets through and nothing in Mirall needs: root on Unix, and
// on Windows a remote peer or one whose user the server could not read.

/**
 * @typedef {{ pid: number | null, uid: number | null, gid: number | null, sid: string | null }} PeerCredentials
 * @param {PeerCredentials | null} creds
 * @param {{ platform: string, uid: number }} self
 * @returns {{ ok: true } | { ok: false, reason: 'no-credentials' | 'remote' | 'unidentified' | 'foreign-uid' }}
 */
export function admitPeer(creds, { platform, uid }) {
  if (!creds) return { ok: false, reason: 'no-credentials' }
  if (platform === 'win32') {
    if (creds.pid === null) return { ok: false, reason: 'remote' }
    if (creds.sid === null) return { ok: false, reason: 'unidentified' }
    return { ok: true }
  }
  if (creds.uid !== uid) return { ok: false, reason: 'foreign-uid' }
  return { ok: true }
}
