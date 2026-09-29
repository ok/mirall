const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const childProcess = require('child_process')

// Owner-only access to the profile. POSIX: mode 0700 on the store directory. Windows has no mode, so
// the user data folder — the store and the envelopes beside it — gets an ACL of this process's own
// account (its token SID, never a name from the environment) and SYSTEM, inheritance removed. Once:
// the ACL is inheritable, and re-applying it on every launch would push it down every file again. A
// marker beside the store records it. Best effort — every secret there is already encrypted — so a
// failure is logged and never stops the app, and nothing here blocks the main thread on Windows.
const SYSTEM_SID = '*S-1-5-18'
const MARKER = '.owner-acl-v1'
const SID = /S-1-[0-9]+(?:-[0-9]+)+/

function icaclsArgs(dir, sid) {
  return [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, `${SYSTEM_SID}:(OI)(CI)F`]
}

async function hardenStorageDirs(storagePath, {
  platform = process.platform,
  chmodSync = fs.chmodSync,
  execFile = promisify(childProcess.execFile),
  log = console,
} = {}) {
  try {
    if (platform !== 'win32') {
      chmodSync(storagePath, 0o700)
      return
    }
    const dataDir = path.dirname(storagePath)
    const marker = path.join(dataDir, MARKER)
    if (fs.existsSync(marker)) return
    const { stdout } = await execFile('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
    const sid = String(stdout).match(SID)?.[0]
    if (!sid) throw new Error('whoami named no SID')
    await execFile('icacls', icaclsArgs(dataDir, sid), { windowsHide: true })
    await fs.promises.writeFile(marker, `${new Date().toISOString()}\n`)
  } catch (err) {
    log.error('[identity] storage perms failed:', err && err.message ? err.message : err)
  }
}

module.exports = { hardenStorageDirs }
