// Identity changes asked for while the store is open: a recovery key adopted on a fresh install, and
// a restore set aside. A store's files cannot move under an open database, so both wait for the next
// worker and run here, before it opens the store. Every step is safe to repeat and the request is
// removed last, so a crash part-way is finished by the next boot.
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { SECRET_FILE } from '../contract/secret-files.js'
import { setAsideLockedData } from './identity-set-aside.js'
import { writeRestoreHold, PROFILE_BEE } from './restore-hold.js'

export const ADOPT_FILE = 'identity-adopt.enc'
const SET_ASIDE_REQUEST = 'set-aside.pending'

function holdsIdentityData(storagePath) {
  const besideIdentity = path.join(path.dirname(storagePath), SECRET_FILE.IDENTITY)
  return fs.existsSync(besideIdentity) || (fs.existsSync(storagePath) && fs.readdirSync(storagePath).length > 0)
}

function setAsideIfHeld(storagePath) {
  if (!holdsIdentityData(storagePath)) return null
  fs.mkdirSync(storagePath, { recursive: true })
  return setAsideLockedData(storagePath)
}

// Setting up the fresh identity is the user choosing it over the key, so a pending adoption that never
// reached a restart is dropped rather than applied over an identity now in use.
export function cancelPendingAdoption(storagePath) {
  fs.rmSync(path.join(path.dirname(storagePath), ADOPT_FILE), { force: true })
}

export function requestSetAside(storagePath) {
  fs.writeFileSync(path.join(path.dirname(storagePath), SET_ASIDE_REQUEST), b4a.alloc(0))
}

// The adopted identity starts with its profile held: this device holds none of it, and the peers
// that do must be caught up with before anything is written (restore-hold.js).
export async function applyPendingIdentityChange(storagePath) {
  const dataDir = path.dirname(storagePath)
  const request = path.join(dataDir, SET_ASIDE_REQUEST)
  const adopt = path.join(dataDir, ADOPT_FILE)
  let folder = null
  if (fs.existsSync(request)) {
    folder = setAsideIfHeld(storagePath)
    fs.rmSync(request)
  }
  if (fs.existsSync(adopt)) {
    folder = setAsideIfHeld(storagePath) ?? folder
    await writeRestoreHold(storagePath, [PROFILE_BEE])
    fs.renameSync(adopt, path.join(dataDir, SECRET_FILE.IDENTITY))
  }
  return folder
}
