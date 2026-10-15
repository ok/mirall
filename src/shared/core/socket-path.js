// Where a profile's worker listens and locks. Pure string math, so the Node unit runner tests it.
//
// Everything sits beside the store, in <dataDir>/run, never inside it: an identity set-aside moves
// every entry of the store directory, and a held lock or a live socket must not move with it. A
// Unix socket path longer than sun_path fails to bind, so a long data directory falls back to a
// per-user directory under the temp root, named by the store so two profiles cannot meet there.

export const SUN_PATH_MAX = 103

/**
 * @param {{ platform: string, dataDir: string, storageHash: string, uid: number, tmpdir: string }} where
 * @returns {{ runDir: string, lock: string, socket: string, socketDir: string | null }}
 */
export function socketPaths({ platform, dataDir, storageHash, uid, tmpdir }) {
  const sep = platform === 'win32' ? '\\' : '/'
  const runDir = dataDir + sep + 'run'
  const lock = runDir + sep + 'daemon.lock'
  if (platform === 'win32') {
    return { runDir, lock, socket: '\\\\.\\pipe\\mirall-' + storageHash.slice(0, 32), socketDir: null }
  }
  const socket = runDir + '/daemon.sock'
  if (utf8Length(socket) <= SUN_PATH_MAX) return { runDir, lock, socket, socketDir: runDir }
  const socketDir = tmpdir + '/mirall-' + uid
  return { runDir, lock, socket: socketDir + '/' + storageHash.slice(0, 16) + '.sock', socketDir }
}

/** @param {string} text */
function utf8Length(text) {
  let bytes = 0
  for (const ch of text) {
    const code = /** @type {number} */ (ch.codePointAt(0))
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}
